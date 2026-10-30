// Contract between the renderer and the Electron main process. Types only: imported by both sides.

import type { Section } from '../audio/types'
import type { AbletonSong } from '../import/ableton'

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
  artist?: string
  album?: string
  /** When it was imported (ms since 1970), for the library's Recent list. */
  added?: number
  /** Cover picture in the song folder (e.g. a MultiTracks download's Album.jpg). */
  artwork?: string
  /** The stem used as the click (a MultiTracks "Click Track"); otherwise the click is generated. */
  clickStem?: string | null
  /** The song's own pad sound; otherwise the Default Ambient Pad. */
  pad?: string
  /** Tempo changes and time signature changes, when it has any. */
  tempos?: { start: number; bpm: number }[]
  meters?: { start: number; timeSig: [number, number] }[]
}

/** An imported pad, as saved in `<library>/Pads/<id>/pad.json` next to its WAVs. */
export interface PadRecord {
  version: 1
  id: string
  name: string
  /** Each WAV and the key its name says it plays (null: none, treated as C). */
  files: { key: string | null; file: string }[]
}

/**
 * What happens when a song in a setlist ends (as in Playback):
 *   cue        the next song is loaded, ready to play (after the last song: the first one)
 *   stay       nothing; the song stays loaded at its end
 *   link       AutoLink: the next song starts straight away
 *   overlap    the next song starts at this one's last section, which plays out underneath
 *   crossfade  as overlap, but this one fades out as the next comes in
 */
export type SongEnd = 'cue' | 'stay' | 'link' | 'overlap' | 'crossfade'

export interface SongEndSetting {
  end: SongEnd
  /** Turn the pad on when the song ends, so there's no silence before the next one. */
  continuePad: boolean
}

export interface SetlistRecord {
  id: string
  name: string
  /** Song ids in order (demo songs are `demo-N`). */
  songs: string[]
  /** Per song, what happens when it ends; missing means cue the next song, pad off. */
  ends?: Record<string, { end?: SongEnd; pad?: boolean }>
  /** Per song, its sections as edited in this setlist; missing means the song's own. */
  sections?: Record<string, Section[]>
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
  /** '' when nothing could be imported from this zip or folder (see `failed`). */
  songId: string
  /** The zip or folder the song came from; a MultiTracks name carries title, album, key and BPM. */
  sourceName?: string
  /** Copied stems: original file name and the name it was saved under. */
  files: { name: string; file: string }[]
  /** Files that couldn't be copied. */
  failed: { name: string; reason: string }[]
  /** Cover picture saved in the song folder. */
  artwork?: string
  /** What the download's Ableton set says: tempo, time signature, section markers. */
  ableton?: AbletonSong | null
}

export interface ImportProgress {
  /** Which song (zip / folder) of how many. */
  song: number
  songs: number
  source: string
  /** The file being copied or unzipped, and bytes done of the whole song. */
  name: string
  done: number
  total: number
}

export type MenuCommand =
  | 'import'
  | 'import-folder'
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
  | 'song-settings'
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
    /**
     * Native dialog for audio files and zips ('files'), or folders ('folders'; on a Mac the
     * files dialog takes folders too). Resolves to [] if cancelled.
     */
    pickImport(kind: 'files' | 'folders'): Promise<string[]>
    /** Each zip and folder becomes a song; loose audio files become one song together. */
    importPaths(paths: string[]): Promise<CreatedSong[]>
    onImportProgress(cb: (p: ImportProgress) => void): () => void
    saveSong(record: SongRecord): Promise<void>
    removeFiles(songId: string, files: string[]): Promise<void>
    /** Deletes a song; it can be restored until Player next starts (Undo). */
    deleteSong(songId: string): Promise<void>
    restoreSong(songId: string): Promise<SongRecord>
    saveState(state: LibraryState): Promise<void>
    /** Each song's size on disk (its folder: stems and cover), by song id. */
    sizes(): Promise<Record<string, number>>
    /** Opens the library folder, or a song's folder, in the file manager. */
    reveal(songId?: string): Promise<void>
  }
  cues: {
    /** Makes spoken cues in a language's voice; resolves to each phrase's file (see cueUrl). */
    render(lang: string, phrases: string[]): Promise<Record<string, string>>
  }
  pads: {
    list(): Promise<PadRecord[]>
    /** Asks for pad zips (or WAVs) and imports them; each zip is one pad. */
    import(): Promise<{ pads: PadRecord[]; failed: { name: string; reason: string }[] }>
    /** Moves an imported pad's folder to the system trash. */
    delete(padId: string): Promise<void>
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

/** URL of a spoken cue made by the main process. */
export function cueUrl(lang: string, file: string): string {
  return `app://player/cues/${encodeURIComponent(lang)}/${encodeURIComponent(file)}`
}

/** URL the renderer fetches an imported pad's WAV from (served by the main process). */
export function padUrl(padId: string, file: string): string {
  return `app://player/pads/${encodeURIComponent(padId)}/${encodeURIComponent(file)}`
}

/** URL the renderer fetches a library stem from (served by the main process). */
export function mediaUrl(songId: string, file: string): string {
  return `app://player/media/${encodeURIComponent(songId)}/${encodeURIComponent(file)}`
}
