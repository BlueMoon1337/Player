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

export type ExportFormat = 'dmg' | 'zip' | 'appimage'

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
  | `export-app:${ExportFormat}`
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
  /** Why update packages can't install here: 'translocated' | 'development' | 'appimage'. */
  packageBlocker: string | null
}

/** A zip update package, looked at but not yet installed (electron/packages.ts). */
export interface PackageInfo {
  /** interface: a new app.asar (all of Player but Electron); app: a whole Player.app; installer: Windows. */
  kind: 'interface' | 'app' | 'installer'
  version: string
  current: string
  /** Signed with Player's release key. */
  signed: boolean
  /** How it compares with the version running now. */
  compared: 'newer' | 'same' | 'older'
  notes: string | null
  file: string
}

/** The version kept from before the last update, to go back to. */
export interface PreviousVersion {
  version: string
  kind: 'interface' | 'bundle' | 'dir'
  savedAt: number
}

/** How the last update or Go Back went, told once after the restart. */
export interface UpdateResult {
  ok: boolean
  action: 'update' | 'revert'
  version: string
  message: string
}

export interface FoundUpdate {
  version: string
  current: string
  notes: string | null
  date: string | null
}

// ------------------------------------------------- console button (Behringer / Midas X32)

/** A strip on an X32 the console button can mute: input channel 1–32, mix bus 1–16 or DCA 1–8. */
export interface ConsoleTarget {
  kind: 'channel' | 'bus' | 'dca'
  number: number
}

/** A console Player has seen on the network, remembered between launches. */
export interface KnownConsole {
  /** The console's network name, e.g. "X32C-08-4E-24". Unlike its address, it doesn't change. */
  name: string
  /** "X32C" for an X32 Compact, "X32" and so on. */
  model: string
  /** Where it was last found. */
  address: string
  /** When it was last seen (ms since 1970). */
  lastSeen: number
  /** What the console button mutes on this console; null when the user chose nothing. */
  target: ConsoleTarget | null
}

export interface ConsoleState {
  consoles: KnownConsole[]
  /** Names of the consoles answering on the network now. */
  online: string[]
  /** Each online console's model ("X32C"…), by name. */
  models: Record<string, string>
  /**
   * The console button: the linked console that's online (else the one seen most recently).
   * Null when no console is linked, and the Master strip looks as it always has.
   */
  button: {
    console: string
    target: ConsoleTarget
    /** The strip's scribble-strip name on the console; '' until known, or if it has none. */
    label: string
    online: boolean
    /** Muted on the console; null while it isn't known. */
    muted: boolean | null
  } | null
  /** A console seen for the first time, waiting for the user to say whether to link it. */
  newConsole: { name: string; model: string; address: string } | null
  /** macOS (Local Network privacy) refused to let Player reach the network. */
  blocked: boolean
  /** Looking for consoles because the user is setting up the button (see search()). */
  searching: boolean
}

// ----------------------------------------------- Lumen (the presentation app) on the network

/** What the Random Countdown, Fade Out Music and Outro boxes ask Lumen to do. */
export type LumenWhat = 'random-countdown' | 'outro' | 'fade-music'

export interface LumenState {
  /** The Lumen the boxes use (one that lets Player play, else any), or null when none answered. */
  lumen: {
    /** The computer it's on. */
    name: string
    /** It has started, and said what it has. */
    ready: boolean
    /** Lumen lets Player play (Lumen's Settings ▸ Player). */
    allowed: boolean
    countdowns: number
    /** The active outro's name; null when Lumen has none. */
    outro: string | null
    /** The track playing on Lumen's Audio layer; null when none. */
    music: string | null
    /** Lumen's active logo, which Fade Out Music clears the screen to; null when none (or not said). */
    logo: string | null
    /**
     * Each command Lumen knows: null when it can be done now, else why not. Missing (Lumen 1.0.17)
     * or without a command: that Lumen doesn't know it.
     */
    can: Partial<Record<LumenWhat, string | null>> | null
  } | null
  /** Other copies of Lumen answering too. */
  others: number
  /** macOS (Local Network privacy) refused to let Player reach the network. */
  blocked: boolean
}

export interface LumenPlayResult {
  ok: boolean
  /** Why not, when it didn't play. */
  message: string | null
  /** The computer whose Lumen played it. */
  lumen?: string
}

/** A strip offered in the console button's picker, with its scribble-strip name. */
export interface ConsoleStrip {
  target: ConsoleTarget
  label: string
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
  /** Export Player: a copy of this installed app, as a disk image, zip or AppImage. */
  selfExport: {
    /** The formats this copy can be exported as; none in a development build. */
    formats(): Promise<ExportFormat[]>
    /** Asks where to save it, then writes it; null if the dialog was cancelled. */
    save(format: ExportFormat): Promise<{ file: string } | null>
    /** Shows the last exported file in Finder / Explorer. */
    show(): Promise<void>
    /** The share written (0..1), or null while it can't be told. */
    onProgress(cb: (done: number | null) => void): () => void
  }
  updates: {
    info(): Promise<UpdateInfo>
    /** Keeps the read-only GitHub token in the main process; '' forgets it. */
    setToken(token: string): Promise<void>
    /** The newer version, or null when up to date. */
    check(): Promise<FoundUpdate | null>
    /** Downloads, verifies, installs and restarts; only returns (by throwing) on failure. */
    install(): Promise<void>
    onProgress(cb: (p: { received: number; total: number | null }) => void): () => void
    /** Asks for a .zip update package and checks it; null if the dialog was cancelled. */
    pickPackage(): Promise<PackageInfo | null>
    /** Forgets the package picked. */
    discardPackage(): Promise<void>
    /** Installs the package picked and restarts; only returns (by throwing) on failure. */
    installPackage(): Promise<void>
    /** The version kept from before the last update, if any. */
    previous(): Promise<PreviousVersion | null>
    /** Puts the previous version back and restarts; only returns (by throwing) on failure. */
    revert(): Promise<void>
    /** How the last update or Go Back went, once, after the restart. */
    takeResult(): Promise<UpdateResult | null>
  }
  onMenu(cb: (cmd: MenuCommand) => void): () => void
  /** Player is closing: save what's waiting; it closes when the promise settles (or after a few seconds). */
  onFlush(cb: () => Promise<void>): () => void
  /** The console button: mutes a channel, bus or DCA on an X32 found on the local network. */
  console: {
    state(): Promise<ConsoleState>
    onState(cb: (s: ConsoleState) => void): () => void
    /** A console's channels, buses and DCAs with their names; it has to be online. */
    strips(consoleName: string): Promise<ConsoleStrip[]>
    /** Links the button to a strip on a console, or with null, to nothing (it's still remembered). */
    link(consoleName: string, target: ConsoleTarget | null): Promise<void>
    /** Mutes or unmutes the button's strip on its console. */
    setMuted(muted: boolean): Promise<void>
    /**
     * Looks for consoles for the next minute (renew it to keep looking). Without a button set up,
     * Player looks for consoles only while a search is on.
     */
    search(): Promise<void>
    /** Forgets a console and what it was linked to. */
    forget(consoleName: string): Promise<void>
  }
  /** Lumen, the presentation app: the Random Countdown and Outro boxes in the song list. */
  lumen: {
    state(): Promise<LumenState>
    onState(cb: (s: LumenState) => void): () => void
    /** Look for Lumen (while the boxes show) or stop. */
    setLooking(on: boolean): void
    /** `seconds`: how long a fade takes. */
    play(what: LumenWhat, seconds?: number): Promise<LumenPlayResult>
  }
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
