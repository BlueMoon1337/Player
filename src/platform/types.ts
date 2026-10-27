// Contract between the renderer and the Electron main process. Types only: imported by both sides.

import type { Section } from '../audio/types'

/** A song as saved in `<library>/Songs/<id>/song.json`. */
export interface SongRecord {
  version: 1
  id: string
  title: string
  key: string
  bpm: number
  timeSig: [number, number]
  clickOffset: number
  duration: number
  sections: Section[]
  stems: { id: string; name: string; file: string }[]
}

export interface SetlistRecord {
  id: string
  name: string
  /** Song ids in order (demo songs are `demo-N`). */
  songs: string[]
}

/** What library.json keeps (version 2). */
export interface LibraryState {
  setlists: SetlistRecord[]
  currentSetlist: string | null
  /** Demo songs deleted from the library. */
  hiddenDemos: string[]
}

export interface LibraryData {
  /** Absolute path of the library folder. */
  root: string
  songs: SongRecord[]
  /** Null until the first save. */
  state: LibraryState | null
}

export interface CreatedSong {
  songId: string
  /** Copied stems: original file name and the name it was saved under. */
  files: { name: string; file: string }[]
  /** Files that couldn't be copied. */
  failed: { name: string; reason: string }[]
}

export type MenuCommand =
  | 'import'
  | 'toggle-play'
  | 'prev'
  | 'next'
  | 'fade'
  | 'loop'
  | 'jump:immediate'
  | 'jump:bar'
  | 'jump:section'
  | 'toggle-setlist'
  | 'toggle-edit'
  | 'outputs'
  | 'pad'
  | 'settings'
  | 'check-updates'
  | 'setlists'
  | 'undo'
  | 'redo'

export interface MenuState {
  jumpMode: 'immediate' | 'bar' | 'section'
  setlistOpen: boolean
  editMode: boolean
  /** What Edit ▸ Undo / Redo would do, e.g. "Delete “Grace Song”". */
  undoLabel?: string | null
  redoLabel?: string | null
}

export interface UpdateInfo {
  version: string
  hasToken: boolean
  /** Why updates can't install here: 'translocated' | 'development' | 'not-appimage'. */
  blocker: string | null
}

export interface FoundUpdate {
  version: string
  current: string
  notes: string | null
  date: string | null
}

export interface DesktopAPI {
  platform: string
  library: {
    load(): Promise<LibraryData>
    /** Native multi-select dialog for stems. Resolves to [] if cancelled. */
    pickStems(): Promise<string[]>
    /** Copies stem files into a new song folder. */
    createSong(paths: string[]): Promise<CreatedSong>
    saveSong(record: SongRecord): Promise<void>
    removeFiles(songId: string, files: string[]): Promise<void>
    /** Deletes a song; it can be restored until Player next starts (Undo). */
    deleteSong(songId: string): Promise<void>
    restoreSong(songId: string): Promise<SongRecord>
    saveState(state: LibraryState): Promise<void>
    /** Opens the library folder, or a song's folder, in the file manager. */
    reveal(songId?: string): Promise<void>
  }
  /** Absolute path of a dropped file ('' if it has none, e.g. dragged from a browser). */
  pathForFile(file: File): string
  /** Tells the app audio is running: keeps the display awake and guards against quitting. */
  setActive(active: boolean): void
  setMenuState(state: MenuState): void
  updates: {
    info(): Promise<UpdateInfo>
    /** Keeps the read-only GitHub token in the main process; '' forgets it. */
    setToken(token: string): Promise<void>
    /** The newer version, or null when up to date. */
    check(): Promise<FoundUpdate | null>
    /** Downloads, verifies, installs and restarts; only returns (by throwing) on failure. */
    install(): Promise<void>
    onProgress(cb: (p: { received: number; total: number | null }) => void): () => void
  }
  onMenu(cb: (cmd: MenuCommand) => void): () => void
}

/** URL the renderer fetches a library stem from (served by the main process). */
export function mediaUrl(songId: string, file: string): string {
  return `app://player/media/${encodeURIComponent(songId)}/${encodeURIComponent(file)}`
}
