/**
 * Undo for song edits (title, key, tempo, time signature, click offset, sections). Each edit
 * records the song's editable fields before and after; undo puts them back. Typing into one
 * field joins into a single step (history.ts).
 */
import type { Section, Song } from '../audio/types'
import { record } from './history'

interface SongSnapshot {
  title: string
  key: string
  bpm: number
  timeSig: [number, number]
  clickOffset: number
  clickStem: string | null
  sections: Section[]
}

function snapshot(song: Song): SongSnapshot {
  return {
    title: song.title,
    key: song.key,
    bpm: song.bpm,
    timeSig: [song.timeSig[0], song.timeSig[1]],
    clickOffset: song.clickOffset,
    clickStem: song.clickStem ?? null,
    sections: song.sections.map((s) => ({ ...s })),
  }
}

const same = (a: SongSnapshot, b: SongSnapshot) => JSON.stringify(a) === JSON.stringify(b)

/** What a change touches beyond the views: the generated click's timing, or where the click comes from. */
export interface ChangeKind {
  timing: boolean
  clickSource: boolean
}

const kindOf = (a: SongSnapshot, b: SongSnapshot): ChangeKind => ({
  timing: a.bpm !== b.bpm || a.timeSig.join('/') !== b.timeSig.join('/') || a.clickOffset !== b.clickOffset,
  clickSource: a.clickStem !== b.clickStem,
})

/** Called after a song changes (by an edit, undo or redo): refresh the engine, the views, and save. */
let changed: (song: Song, kind: ChangeKind) => void = () => {}
export function onSongChanged(fn: (song: Song, kind: ChangeKind) => void) {
  changed = fn
}

function apply(song: Song, snap: SongSnapshot, kind: ChangeKind) {
  Object.assign(song, {
    title: snap.title,
    key: snap.key,
    bpm: snap.bpm,
    timeSig: [snap.timeSig[0], snap.timeSig[1]],
    clickOffset: snap.clickOffset,
    clickStem: snap.clickStem,
    sections: snap.sections.map((s) => ({ ...s })),
  })
  changed(song, kind)
}

/**
 * Makes an edit to a song as one undoable step. `mergeKey` names the field being typed into,
 * so that a burst of typing is one step.
 */
export function editSong(song: Song, label: string, change: () => void, mergeKey?: string) {
  const before = snapshot(song)
  change()
  const after = snapshot(song)
  if (same(before, after)) return
  const kind = kindOf(before, after)
  changed(song, kind)
  record({
    label,
    mergeKey: mergeKey ? `${song.id}:${mergeKey}` : undefined,
    undo: () => apply(song, before, kind),
    redo: () => apply(song, after, kind),
  })
}
