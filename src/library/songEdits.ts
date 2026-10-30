/**
 * Undo for song edits (title, artist, album, key, tempo, time signature, click offset, sections,
 * and which setlists have their own edit of the sections). Each edit
 * records the song's editable fields before and after; undo puts them back. Typing into one
 * field joins into a single step (history.ts).
 */
import type { MeterChange, TempoChange } from '../audio/grid'
import type { Section, Song } from '../audio/types'
import { record } from './history'
import { getLibrary, setSetlistSections } from './store'

interface SongSnapshot {
  title: string
  artist: string | undefined
  album: string | undefined
  key: string
  bpm: number
  timeSig: [number, number]
  clickOffset: number
  clickStem: string | null
  pad: string | undefined
  tempos: TempoChange[] | undefined
  meters: MeterChange[] | undefined
  sections: Section[]
  /** The song's own sections, and each setlist's edit of them (by setlist id). */
  own: Section[] | undefined
  inSetlists: Record<string, Section[]>
}

function snapshot(song: Song): SongSnapshot {
  return {
    title: song.title,
    artist: song.artist,
    album: song.album,
    key: song.key,
    bpm: song.bpm,
    timeSig: [song.timeSig[0], song.timeSig[1]],
    clickOffset: song.clickOffset,
    clickStem: song.clickStem ?? null,
    pad: song.pad,
    tempos: song.tempos?.map((t) => ({ ...t })),
    meters: song.meters?.map((m) => ({ start: m.start, timeSig: [m.timeSig[0], m.timeSig[1]] })),
    sections: song.sections.map((s) => ({ ...s })),
    own: song.librarySections?.map((s) => ({ ...s })),
    inSetlists: Object.fromEntries(
      getLibrary()
        .setlists.filter((sl) => sl.sections?.[song.id])
        .map((sl) => [sl.id, sl.sections![song.id].map((s) => ({ ...s }))]),
    ),
  }
}

const same = (a: SongSnapshot, b: SongSnapshot) => JSON.stringify(a) === JSON.stringify(b)

/** What a change touches beyond the views: the generated click's timing, or where the click comes from. */
export interface ChangeKind {
  timing: boolean
  clickSource: boolean
}

const kindOf = (a: SongSnapshot, b: SongSnapshot): ChangeKind => ({
  timing:
    a.bpm !== b.bpm ||
    a.timeSig.join('/') !== b.timeSig.join('/') ||
    a.clickOffset !== b.clickOffset ||
    JSON.stringify([a.tempos, a.meters]) !== JSON.stringify([b.tempos, b.meters]),
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
    artist: snap.artist,
    album: snap.album,
    key: snap.key,
    bpm: snap.bpm,
    timeSig: [snap.timeSig[0], snap.timeSig[1]],
    clickOffset: snap.clickOffset,
    clickStem: snap.clickStem,
    pad: snap.pad,
    tempos: snap.tempos?.map((t) => ({ ...t })),
    meters: snap.meters?.map((m) => ({ start: m.start, timeSig: [m.timeSig[0], m.timeSig[1]] })),
    sections: snap.sections.map((s) => ({ ...s })),
    librarySections: snap.own?.map((s) => ({ ...s })),
  })
  for (const sl of getLibrary().setlists) {
    const want = snap.inSetlists[sl.id] ?? null
    if (JSON.stringify(sl.sections?.[song.id] ?? null) !== JSON.stringify(want)) setSetlistSections(sl.id, song.id, want)
  }
  changed(song, kind)
}

/**
 * Makes an edit to a song as one undoable step. `mergeKey` names the field being typed into,
 * so that a burst of typing is one step.
 */
export function editSong(song: Song, label: string, change: () => void, mergeKey?: string) {
  const before = snapshot(song)
  change()
  const made = snapshot(song)
  if (same(before, made)) return
  const kind = kindOf(before, made)
  changed(song, kind)
  // After the change has been filed with its setlist (App's onSongChanged), so redo puts that back too.
  const after = snapshot(song)
  record({
    label,
    mergeKey: mergeKey ? `${song.id}:${mergeKey}` : undefined,
    undo: () => apply(song, before, kind),
    redo: () => apply(song, after, kind),
  })
}
