/**
 * The song library and its setlists. Every song lives in the library (demos and imported songs);
 * a setlist is an ordered list of library songs, and the main window plays the current one.
 * Changes go through here so each is one undoable step (history.ts) and is saved: on desktop to
 * library.json in the library folder, on the web to this browser's storage.
 */
import { useSyncExternalStore } from 'react'
import { demoSongs } from '../audio/synth'
import { type Song, uid } from '../audio/types'
import { desktop } from '../platform'
import { songFromRecord } from '../platform/library'
import type { LibraryState, SetlistRecord } from '../platform/types'
import { UNDO_KEY, record, showNote } from './history'

export type Setlist = SetlistRecord

export interface LibrarySnapshot {
  ready: boolean
  root: string | null
  songs: Record<string, Song>
  setlists: Setlist[]
  currentSetlistId: string
  hiddenDemos: string[]
  /** Bumped when a song is changed in place, so views re-render. */
  version: number
}

const WEB_KEY = 'player.library.v1'

let state: LibrarySnapshot = {
  ready: false,
  root: null,
  songs: {},
  setlists: [],
  currentSetlistId: '',
  hiddenDemos: [],
  version: 0,
}
const listeners = new Set<() => void>()

function set(patch: Partial<LibrarySnapshot>, save = true) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
  if (save && state.ready) scheduleSave()
}

export const getLibrary = () => state

export function useLibrary(): LibrarySnapshot {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
}

// ------------------------------------------------------------------ saving

let saveTimer: number | undefined
let saveError: ((message: string) => void) | null = null

/** Where save failures are reported (the app shows them). */
export function onSaveError(fn: (message: string) => void) {
  saveError = fn
}

function persisted(): LibraryState {
  return { setlists: state.setlists, currentSetlist: state.currentSetlistId, hiddenDemos: state.hiddenDemos }
}

function scheduleSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    if (desktop) {
      desktop.library.saveState(persisted()).catch((e: Error) => saveError?.(`Couldn’t save the setlists: ${e.message}`))
    } else {
      try {
        localStorage.setItem(WEB_KEY, JSON.stringify(persisted()))
      } catch {
        /* storage unavailable */
      }
    }
  }, 150)
}

// ---------------------------------------------------------------- loading

function firstSetlist(demos: Song[]): Setlist {
  return { id: uid('setlist'), name: 'My Setlist', songs: demos.map((d) => d.id) }
}

/** Loads the library: from the library folder on desktop, the demo songs on the web. */
export async function loadLibrary(): Promise<void> {
  const demos = demoSongs()
  let saved: LibraryState | null = null
  let songs: Song[] = []
  let root: string | null = null
  if (desktop) {
    const data = await desktop.library.load()
    root = data.root
    saved = data.state
    songs = data.songs.map(songFromRecord)
  } else {
    try {
      saved = JSON.parse(localStorage.getItem(WEB_KEY) || 'null')
    } catch {
      saved = null
    }
  }
  const hiddenDemos = saved?.hiddenDemos ?? []
  const all: Record<string, Song> = {}
  for (const s of [...demos.filter((d) => !hiddenDemos.includes(d.id)), ...songs]) all[s.id] = s
  let setlists = (saved?.setlists ?? []).map((sl) => ({ ...sl, songs: sl.songs.filter((id) => all[id]) }))
  if (!setlists.length) setlists = [firstSetlist(Object.values(all).filter((s) => s.source === 'demo'))]
  const current = setlists.find((s) => s.id === saved?.currentSetlist) ?? setlists[0]
  set({ ready: true, root, songs: all, setlists, currentSetlistId: current.id, hiddenDemos }, false)
}

// --------------------------------------------------------------- reading

export function librarySongs(s = state): Song[] {
  return Object.values(s.songs).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}

export function currentSetlist(s = state): Setlist {
  return s.setlists.find((x) => x.id === s.currentSetlistId) ?? s.setlists[0]
}

export function setlistSongs(setlist: Setlist | undefined, s = state): Song[] {
  return (setlist?.songs ?? []).map((id) => s.songs[id]).filter((x): x is Song => !!x)
}

/** The setlists a song is in. */
export function setlistsWith(songId: string, s = state): Setlist[] {
  return s.setlists.filter((sl) => sl.songs.includes(songId))
}

const title = (id: string) => `“${state.songs[id]?.title ?? 'song'}”`

// ------------------------------------------------------------ setlist edits

function replaceSetlist(id: string, f: (sl: Setlist) => Setlist) {
  set({ setlists: state.setlists.map((sl) => (sl.id === id ? f(sl) : sl)) })
}

/** Runs a change and records it, with a snapshot of the setlists to go back to. */
function setlistStep(label: string, change: () => void) {
  const before = state.setlists
  const beforeCurrent = state.currentSetlistId
  change()
  const after = state.setlists
  const afterCurrent = state.currentSetlistId
  record({
    label,
    undo: () => set({ setlists: before, currentSetlistId: beforeCurrent }),
    redo: () => set({ setlists: after, currentSetlistId: afterCurrent }),
  })
}

export function setCurrentSetlist(id: string) {
  if (state.setlists.some((s) => s.id === id)) set({ currentSetlistId: id })
}

export function addToSetlist(setlistId: string, songIds: string[], index?: number) {
  const sl = state.setlists.find((s) => s.id === setlistId)
  if (!sl || !songIds.length) return
  const label = songIds.length === 1 ? `Add ${title(songIds[0])} to ${sl.name}` : `Add ${songIds.length} Songs to ${sl.name}`
  setlistStep(label, () =>
    replaceSetlist(setlistId, (s) => {
      const songs = [...s.songs]
      songs.splice(index ?? songs.length, 0, ...songIds)
      return { ...s, songs }
    }),
  )
}

/** Takes one entry out of a setlist; the song stays in the library. */
export function removeFromSetlist(setlistId: string, index: number) {
  const sl = state.setlists.find((s) => s.id === setlistId)
  const songId = sl?.songs[index]
  if (!sl || !songId) return
  setlistStep(`Remove ${title(songId)} from ${sl.name}`, () =>
    replaceSetlist(setlistId, (s) => ({ ...s, songs: s.songs.filter((_, i) => i !== index) })),
  )
  showNote(`Removed ${title(songId)} from “${sl.name}”. It’s still in the library. ${UNDO_KEY} undoes this.`, true)
}

export function moveInSetlist(setlistId: string, from: number, to: number) {
  const sl = state.setlists.find((s) => s.id === setlistId)
  if (!sl || from === to || to < 0 || to >= sl.songs.length) return
  setlistStep(`Move ${title(sl.songs[from])}`, () =>
    replaceSetlist(setlistId, (s) => {
      const songs = [...s.songs]
      const [moved] = songs.splice(from, 1)
      songs.splice(to, 0, moved)
      return { ...s, songs }
    }),
  )
}

export function newSetlist(name: string, songs: string[] = []): string {
  const id = uid('setlist')
  setlistStep(`New Setlist “${name}”`, () => set({ setlists: [...state.setlists, { id, name, songs }], currentSetlistId: id }))
  return id
}

export function renameSetlist(id: string, name: string) {
  const sl = state.setlists.find((s) => s.id === id)
  if (!sl || !name.trim() || sl.name === name) return
  setlistStep(`Rename Setlist to “${name}”`, () => replaceSetlist(id, (s) => ({ ...s, name: name.trim() })))
}

export function duplicateSetlist(id: string) {
  const sl = state.setlists.find((s) => s.id === id)
  if (!sl) return
  const copy = { id: uid('setlist'), name: `${sl.name} copy`, songs: [...sl.songs] }
  const at = state.setlists.indexOf(sl) + 1
  setlistStep(`Duplicate Setlist “${sl.name}”`, () => {
    const setlists = [...state.setlists]
    setlists.splice(at, 0, copy)
    set({ setlists, currentSetlistId: copy.id })
  })
}

/** Deletes a setlist (its songs stay in the library). There is always at least one setlist. */
export function deleteSetlist(id: string) {
  const i = state.setlists.findIndex((s) => s.id === id)
  if (i < 0) return
  const sl = state.setlists[i]
  setlistStep(`Delete Setlist “${sl.name}”`, () => {
    let setlists = state.setlists.filter((s) => s.id !== id)
    if (!setlists.length) setlists = [{ id: uid('setlist'), name: 'My Setlist', songs: [] }]
    const current = state.currentSetlistId === id ? setlists[Math.min(i, setlists.length - 1)].id : state.currentSetlistId
    set({ setlists, currentSetlistId: current })
  })
  showNote(`Deleted the setlist “${sl.name}”. ${UNDO_KEY} undoes this.`, true)
}

// ------------------------------------------------------------- song edits

/** Adds newly imported songs to the library, and to a setlist. Undo deletes them again. */
export function importSongs(songs: Song[], setlistId = state.currentSetlistId) {
  const before = { songs: state.songs, setlists: state.setlists }
  const add = () => {
    const all = { ...state.songs }
    for (const s of songs) all[s.id] = s
    set({
      songs: all,
      setlists: state.setlists.map((sl) => (sl.id === setlistId ? { ...sl, songs: [...sl.songs, ...songs.map((s) => s.id)] } : sl)),
    })
  }
  add()
  const after = { songs: state.songs, setlists: state.setlists }
  const library = songs.filter((s) => s.source === 'library')
  record({
    label: songs.length === 1 ? `Import “${songs[0].title}”` : `Import ${songs.length} Songs`,
    undo: async () => {
      for (const s of library) await desktop?.library.deleteSong(s.id)
      set({ songs: before.songs, setlists: before.setlists })
    },
    redo: async () => {
      for (const s of library) await desktop?.library.restoreSong(s.id)
      set({ songs: after.songs, setlists: after.setlists })
    },
  })
}

/**
 * Deletes a song from the library and every setlist. Its files are kept until Player next
 * starts, so Undo brings it back (a demo song is just hidden).
 */
export async function deleteSong(songId: string) {
  const song = state.songs[songId]
  if (!song) return
  const before = { songs: state.songs, setlists: state.setlists, hiddenDemos: state.hiddenDemos }
  const remove = async () => {
    if (song.source === 'library') await desktop?.library.deleteSong(songId)
    const songs = { ...state.songs }
    delete songs[songId]
    set({
      songs,
      setlists: state.setlists.map((sl) => ({ ...sl, songs: sl.songs.filter((id) => id !== songId) })),
      hiddenDemos: song.source === 'demo' ? [...state.hiddenDemos, songId] : state.hiddenDemos,
    })
  }
  await remove()
  showNote(`Deleted “${song.title}” from the library. ${UNDO_KEY} undoes this.`, true)
  record({
    label: `Delete “${song.title}”`,
    undo: async () => {
      if (song.source === 'library') await desktop?.library.restoreSong(songId)
      set({ songs: { ...state.songs, [songId]: song }, setlists: before.setlists, hiddenDemos: before.hiddenDemos })
    },
    redo: remove,
  })
}

/** Call after changing a song in place (title, tempo, sections…) so views update. */
export function songChanged() {
  set({ version: state.version + 1 }, false)
}
