import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, type JumpMode, type LoopMode } from './audio/engine'
import { type ImportResult, fileSource, importStems, isAudioFile } from './audio/importer'
import { type ImportedPad, PAD_SOUNDS, PadPlayer } from './audio/pad'
import { computePeaks } from './audio/peaks'
import { renderDemoStems } from './audio/synth'
import { type Song, keyRoot, sectionIndexAt } from './audio/types'
import { AskHost, ContextMenuHost, confirmDelete, isAsking } from './components/Ask'
import { type LowerView, Mixer } from './components/Mixer'
import { Menu, OutputsDialog, SongSettingsDialog } from './components/Panels'
import { Setlist } from './components/Setlist'
import { LibraryPicker } from './components/LibraryPicker'
import { SetlistsMenu } from './components/SetlistsMenu'
import { Timeline } from './components/Timeline'
import { Transport } from './components/Transport'
import { UpdateDialog } from './components/UpdateDialog'
import { clearNote, redo, undo, useHistory } from './library/history'
import { editSong, onSongChanged } from './library/songEdits'
import {
  addToSetlist,
  currentSetlist,
  importSongs,
  loadLibrary,
  moveInSetlist,
  onSaveError,
  removeFromSetlist,
  setlistSongs,
  setSongEnd,
  songChanged,
  songEnd,
  useLibrary,
} from './library/store'
import { type MenuCommand, desktop } from './platform'
import { type PadRecord, type SongEndSetting, padUrl } from './platform/types'
import { type LibraryImport, importIntoLibrary, loadSongStems, recordFromSong } from './platform/library'
import { PAD_FILE, keyFromFileName, padNameFromFiles } from './import/pads'
import { readZipPad, readZipSong } from './import/webZip'
import { checkForUpdates, startUpdateChecks, useUpdates } from './platform/updates'

// One audio graph for the lifetime of the page.
const engine = new Engine()
const pad = new PadPlayer(engine.ctx)

const SETTINGS_KEY = 'player.settings.v1'

/** A pad saved in the library folder, read from there when it plays. */
const padFromRecord = (r: PadRecord): ImportedPad => ({
  id: r.id,
  name: r.name,
  files: r.files.map((f) => ({ key: f.key, name: f.file, input: padUrl(r.id, f.file) })),
})

function loadSettings(): { jumpMode: JumpMode; fadeSeconds: number; link: boolean; padSound: string; autoPad: boolean } {
  const defaults = { jumpMode: 'bar' as JumpMode, fadeSeconds: 4, link: false, padSound: 'warm', autoPad: true }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return defaults
  }
}

type Notice = { kind: 'info' | 'warn' | 'error'; text: string }

function importNotice({ results, failed }: LibraryImport): Notice {
  const skipped = [...failed, ...results.flatMap((r) => r.skipped)]
  let text: string
  if (results.length === 1) {
    const { song, notes } = results[0]
    text = `Imported “${song.title}” (${song.stems.length} stem${song.stems.length === 1 ? '' : 's'})`
    if (notes.length) text += ` · used ${notes.join(', ')}`
  } else {
    text = `Imported ${results.length} songs: ${results.map((r) => r.song.title).join(', ')}`
  }
  if (skipped.length) text += `. Skipped ${skipped.map((f) => `${f.name} (${f.reason})`).join(', ')}`
  const warnings = results.flatMap((r) => (results.length > 1 ? r.warnings.map((w) => `${r.song.title}: ${w}`) : r.warnings))
  if (warnings.length) text += `. ${warnings.join(' ')}`
  return { kind: skipped.length || warnings.length ? 'warn' : 'info', text }
}

const progressText = (verb: string) => (done: number, total: number, name: string) =>
  total > 1 ? `${verb} ${done + 1} of ${total}: ${name}` : `${verb} ${name}…`

/** Typing in a field: keys (and ⌘Z) belong to it. */
const inTextField = (el: Element | null) => !!el?.closest('input, select, textarea')

export default function App() {
  const state = useSyncExternalStore(engine.subscribe, engine.getState)
  const lib = useLibrary()
  const history = useHistory()
  const setlist = lib.ready ? currentSetlist(lib) : null
  // The main window plays the current setlist.
  const songs = useMemo(() => setlistSongs(setlist ?? undefined, lib), [setlist, lib])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [version, setVersion] = useState(0)
  // Edit mode: Playback's "Setlist / Song Map".
  const [editing, setEditingState] = useState(false)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  /** The Library popover, opened from a + in the setlist: adding at this position. */
  const [addAt, setAddAt] = useState<{ index: number; anchor: DOMRect } | null>(null)
  const [setlistOpen, setSetlistOpen] = useState(true)
  const [setlistsOpen, setSetlistsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const updates = useUpdates()
  const updateReady = updates.status === 'available' && updates.found ? updates.found.version : null
  /** The lower part: mixer, buses or pad player (Playback's side buttons). */
  const [lowerView, setLowerView] = useState<LowerView>('mixer')
  const [outputsOpen, setOutputsOpen] = useState(false)
  const [padOn, setPadOnState] = useState(false)
  const [padKey, setPadKeyState] = useState('C')
  const [padFollow, setPadFollow] = useState(true)
  const [dragging, setDragging] = useState(false)
  const initial = useMemo(loadSettings, [])
  const [jumpMode, setJumpMode] = useState<JumpMode>(initial.jumpMode)
  const [fadeSeconds, setFadeSeconds] = useState(initial.fadeSeconds)
  const [link, setLink] = useState(initial.link)
  const [padSound, setPadSoundState] = useState(initial.padSound)
  /** The pad comes on, in the song's key, when a song starts. */
  const [autoPad, setAutoPad] = useState(initial.autoPad)
  const [importedPads, setImportedPads] = useState<ImportedPad[]>([])
  const padPicker = useRef<HTMLInputElement>(null)
  const peaks = useRef(new Map<string, Float32Array>())
  const saveTimers = useRef(new Map<string, number>())

  const setEditing = (on: boolean) => setEditingState(on)

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ jumpMode, fadeSeconds, link, padSound, autoPad }))
    } catch {
      /* storage unavailable */
    }
  }, [jumpMode, fadeSeconds, link, padSound, autoPad])

  const setPadSound = (id: string) => {
    setPadSoundState(id)
    pad.setSound(id)
  }

  // Imported pads: on desktop, the ones saved in the library folder. The saved choice of sound
  // applies once they're known (it may be one of them).
  useEffect(() => {
    pad.onError = (text) => setNotice({ kind: 'warn', text })
    const apply = (pads: ImportedPad[]) => {
      pad.setImported(pads)
      setImportedPads(pads)
      const known = pads.some((x) => x.id === initial.padSound) || PAD_SOUNDS.some((s) => s.id === initial.padSound)
      setPadSound(known ? initial.padSound : PAD_SOUNDS[0].id)
    }
    if (!desktop) return apply([])
    desktop.pads
      .list()
      .then((recs) => apply(recs.map(padFromRecord)))
      .catch(() => apply([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Adds imported pads, picks the first, and says what came in (and what didn't). */
  const addPads = (pads: ImportedPad[], failed: { name: string; reason: string }[]) => {
    if (pads.length) {
      const all = [...importedPads, ...pads].sort((a, b) => a.name.localeCompare(b.name))
      pad.setImported(all)
      setImportedPads(all)
      setPadSound(pads[0].id)
    }
    const keys = (x: ImportedPad) => new Set(x.files.map((f) => f.key ?? 'C')).size
    let text = pads.length
      ? `Imported ${pads.map((x) => `“${x.name}” (${keys(x)} of 12 keys${keys(x) < 12 ? '; the rest are pitched from the nearest' : ''})`).join(', ')}`
      : 'No pads imported'
    if (failed.length) text += `. Skipped ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`
    setNotice({ kind: failed.length || !pads.length ? 'warn' : 'info', text })
  }

  /** IMPORT in the Pad Player: zips of WAVs (each one pad), or WAV files (together one pad). */
  const importPads = async () => {
    if (!desktop) return padPicker.current?.click()
    try {
      setLoading('Importing pads…')
      const { pads, failed } = await desktop.pads.import()
      if (pads.length || failed.length) addPads(pads.map(padFromRecord), failed)
    } catch (e) {
      setNotice({ kind: 'error', text: `Couldn't import pads: ${(e as Error).message}` })
    } finally {
      setLoading(null)
    }
  }

  /** The web version: pads read from the chosen files, for this session only. */
  const importPadFiles = async (files: File[]) => {
    const pads: ImportedPad[] = []
    const failed: { name: string; reason: string }[] = []
    const id = () => `web-pad-${Date.now().toString(36)}-${pads.length}`
    for (const f of files.filter((f) => /\.zip$/i.test(f.name))) {
      try {
        const z = await readZipPad(f)
        pads.push({ id: id(), name: z.name, files: z.files })
      } catch (e) {
        failed.push({ name: f.name, reason: (e as Error).message })
      }
    }
    const wavs = files.filter((f) => PAD_FILE.test(f.name))
    if (wavs.length) {
      pads.push({
        id: id(),
        name: padNameFromFiles(wavs.map((f) => f.name)),
        files: wavs.map((f) => ({ key: keyFromFileName(f.name), name: f.name, input: f })),
      })
    }
    for (const f of files) if (!/\.zip$/i.test(f.name) && !PAD_FILE.test(f.name)) failed.push({ name: f.name, reason: 'not a zip or WAV file' })
    addPads(pads, failed)
  }

  const deletePad = async (x: ImportedPad) => {
    const ok = await confirmDelete({ title: `Delete the pad “${x.name}”?`, message: 'Its WAV files go to the trash.' }, `The pad “${x.name}”`)
    if (!ok || !desktop) return
    try {
      await desktop.pads.delete(x.id)
      const rest = importedPads.filter((p) => p.id !== x.id)
      pad.setImported(rest)
      setImportedPads(rest)
      if (padSound === x.id) setPadSound(PAD_SOUNDS[0].id)
    } catch (e) {
      setNotice({ kind: 'error', text: `Couldn't delete the pad: ${(e as Error).message}` })
    }
  }

  useEffect(() => {
    engine.fadeSeconds = fadeSeconds
  }, [fadeSeconds])

  // Reconnect to the last-used audio interface if it's present.
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((d) => engine.restoreOutputDevice(d))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const t = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [notice])

  // The undo note fades after a few seconds.
  useEffect(() => {
    if (!history.note) return
    const t = window.setTimeout(clearNote, 5000)
    return () => window.clearTimeout(t)
  }, [history.note])

  // Desktop: look for a newer Player soon after start-up and every few hours.
  useEffect(() => startUpdateChecks(), [])

  // Load the library (from the library folder on desktop) and its setlists.
  useEffect(() => {
    onSaveError((text) => setNotice({ kind: 'error', text }))
    loadLibrary().catch((e: Error) => setNotice({ kind: 'error', text: `Couldn't open the song library: ${e.message}` }))
  }, [])

  // Desktop: keep the display awake and guard quitting while audio runs.
  useEffect(() => {
    desktop?.setActive(state.playing || padOn)
  }, [state.playing, padOn])

  useEffect(() => {
    desktop?.setMenuState({
      jumpMode,
      setlistOpen,
      editMode: editing,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    })
  }, [jumpMode, setlistOpen, editing, history.undoLabel, history.redoLabel])

  const song = (currentId && lib.songs[currentId]) || null

  useEffect(() => {
    // As Playback's window does: "Yo Te Bendeciré (Setlist / Song Map)" while editing.
    document.title = song ? (editing ? `${song.title} (Setlist / Song Map)` : `${song.title} — Player`) : 'Player'
  }, [song?.title, editing])

  const setPadOn = (on: boolean) => {
    setPadOnState(on)
    void pad.setOn(on)
  }
  const setPadKey = (k: string) => {
    setPadKeyState(k)
    pad.setKey(k)
  }

  // Pad On When a Song Starts: the first time each song plays (also when the next song comes in by
  // AutoLink, Overlap or Crossfade), and whenever it plays from the top; not on resuming after a pause.
  const autoPadSong = useRef<string | null>(null)
  useEffect(() => {
    if (!state.playing || !song) return
    const fresh = autoPadSong.current !== song.id || engine.position < 0.5
    autoPadSong.current = song.id
    if (!fresh || !autoPad) return
    setPadKey(keyRoot(song.key))
    if (!padOn) setPadOn(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.playing, song?.id])

  /** Stem loads under way (or done), so a preload and a selection never decode the same song twice. */
  const stemLoads = useRef(new Map<string, Promise<void>>())

  /** Renders or reads a song's stems if they aren't in memory. `quiet` (a preload) shows no overlay. */
  const ensureStems = useCallback((target: Song, quiet = false): Promise<void> => {
    if (target.stems.length || (target.source !== 'demo' && target.source !== 'library')) return Promise.resolve()
    const pending = stemLoads.current.get(target.id)
    if (pending) {
      if (!quiet) setLoading(`Loading “${target.title}”…`)
      return pending.finally(() => !quiet && setLoading(null))
    }
    const job = (async () => {
      if (target.source === 'demo') {
        if (!quiet) setLoading(`Rendering “${target.title}”…`)
        // Let the overlay paint before the synchronous render.
        await new Promise((r) => setTimeout(r, 30))
        target.stems = renderDemoStems(engine.ctx, target)
      } else {
        if (!quiet) setLoading(`Loading “${target.title}”…`)
        const { stems, missing } = await loadSongStems(engine.ctx, target, (d, t, n) => {
          if (!quiet) setLoading(progressText('Loading')(d, t, n))
        })
        target.stems = stems
        if (missing.length) {
          setNotice({ kind: 'warn', text: `“${target.title}”: couldn't load ${missing.join(', ')}` })
        }
      }
      if (!peaks.current.has(target.id)) peaks.current.set(target.id, computePeaks(target.stems, target.duration))
    })().finally(() => {
      stemLoads.current.delete(target.id)
      if (!quiet) setLoading(null)
    })
    stemLoads.current.set(target.id, job)
    return job
  }, [])

  /**
   * Loads a library song into the player (rendering or reading its stems first). `start`: just
   * load it ('cue'), load and play it ('play'), or hand it in under the playing song (Overlap /
   * Crossfade) without stopping that one first.
   */
  const selectSong = useCallback(
    async (id: string, start: 'cue' | 'play' | { crossfade: number | null } = 'cue') => {
      const target = lib.songs[id]
      if (!target) return
      const handoff = typeof start === 'object' ? start : null
      if (!handoff) engine.pause()
      await ensureStems(target, !!handoff)
      // Demo and library stems can be reloaded at any time, so only keep the current song in memory.
      for (const s of Object.values(lib.songs)) if (s.id !== id && s.source !== 'user') s.stems = []
      if (!peaks.current.has(id)) peaks.current.set(id, computePeaks(target.stems, target.duration))
      if (handoff) await engine.handOff(target, handoff.crossfade)
      else engine.load(target)
      setCurrentId(id)
      engine.sendMidi([0xc0, Math.max(0, songs.indexOf(target)) & 0x7f])
      if (padFollow) setPadKey(keyRoot(target.key))
      if (start === 'play') await engine.play()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lib, songs, padFollow, ensureStems],
  )

  // Load the first song once the library is ready.
  useEffect(() => {
    if (lib.ready && !currentId && songs.length) void selectSong(songs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.ready])

  // The loaded song was deleted: stop, and load the first song of the setlist instead.
  useEffect(() => {
    if (!currentId || lib.songs[currentId]) return
    engine.unload()
    peaks.current.delete(currentId)
    setCurrentId(null)
    if (songs.length) void selectSong(songs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.songs, currentId])

  /**
   * What happens when the song at `index` ends: what its card in the setlist says. The Link
   * switch makes AutoLink the default; after the last song, the first is cued (unless it stays).
   */
  const endFor = useCallback(
    (index: number): SongEndSetting => {
      const s = songEnd(setlist ?? undefined, songs[index].id)
      let end = s.end
      if (link && end === 'cue') end = 'link'
      if (index === songs.length - 1 && end !== 'stay') end = 'cue'
      return { ...s, end }
    },
    [setlist, songs, link],
  )
  const currentIndex = songs.findIndex((s) => s.id === currentId)

  useEffect(
    () =>
      engine.onEnded(() => {
        const i = currentIndex
        if (i < 0) return
        const { end, continuePad } = endFor(i)
        if (continuePad) setPadOn(true)
        if (end === 'stay') return
        if (end === 'cue') {
          const next = songs[i + 1] ?? songs[0]
          if (next.id === currentId) engine.seek(0)
          else void selectSong(next.id)
        } else {
          // AutoLink, or an Overlap / Crossfade whose hand-off point was never crossed.
          void selectSong(songs[i + 1].id, 'play')
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentIndex, currentId, songs, endFor, selectSong],
  )

  // Overlap / Crossfade: the next song comes in at this one's last section (or a fade length before
  // its end). It, and AutoLink's next song, are read into memory ahead of time so there's no gap.
  useEffect(() => {
    const i = currentIndex
    const next = songs[i + 1]
    if (i < 0 || !song || !next) return void engine.setHandoff(null)
    const { end, continuePad } = endFor(i)
    if (end === 'link' || end === 'overlap' || end === 'crossfade') {
      void ensureStems(next, true).catch(() => {})
    }
    if (end !== 'overlap' && end !== 'crossfade') return void engine.setHandoff(null)
    const last = song.sections.length > 1 ? song.sections[song.sections.length - 1].start : null
    engine.setHandoff(last ?? Math.max(0, song.duration - fadeSeconds))
    return engine.onHandoff(() => {
      if (continuePad) setPadOn(true)
      void selectSong(next.id, { crossfade: end === 'crossfade' ? fadeSeconds : null })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, song, songs, endFor, selectSong, ensureStems, fadeSeconds, version])

  const step = useCallback(
    (dir: -1 | 1) => {
      const i = songs.findIndex((s) => s.id === currentId)
      const next = songs[i + dir]
      if (next) void selectSong(next.id)
    },
    [songs, currentId, selectSong],
  )

  /** ← key: back to the start, or to the previous song when already there. */
  const onPrev = useCallback(() => {
    if (engine.position > 2 || !songs.length || songs[0].id === currentId) engine.seek(0)
    else step(-1)
  }, [songs, currentId, step])

  /** Imports one or more songs: into the library, onto the end of the current setlist, first one loaded. */
  const runImport = useCallback(async (job: (status: (text: string) => void) => Promise<LibraryImport>) => {
    setNotice(null)
    setLoading('Importing…')
    try {
      const imported = await job(setLoading)
      const { results, failed } = imported
      if (!results.length) throw new Error(failed.map((f) => `${f.name}: ${f.reason}`).join('; ') || 'nothing to import')
      const songs = results.map((r) => r.song)
      importSongs(songs)
      for (const s of songs) peaks.current.set(s.id, computePeaks(s.stems, s.duration))
      // Keep only the song being loaded in memory; library songs reload from disk when chosen.
      for (const s of songs.slice(1)) if (s.source === 'library') s.stems = []
      engine.pause()
      engine.load(songs[0])
      setCurrentId(songs[0].id)
      if (padFollow) setPadKey(keyRoot(songs[0].key))
      if (songs.length === 1) setEditing(true)
      setNotice(importNotice(imported))
    } catch (e) {
      setNotice({ kind: 'error', text: `Couldn't import: ${(e as Error).message}` })
    } finally {
      setLoading(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padFollow])

  /** Desktop: zips, folders and audio files are copied (unzipped) into the library, then decoded. */
  const importPaths = useCallback(
    (paths: string[]) => {
      if (desktop && paths.length) void runImport((status) => importIntoLibrary(desktop!, engine.ctx, paths, status))
    },
    [runImport],
  )

  /** Web: each zip is a song, loose audio files are one song; decoded in memory only. On desktop, by path. */
  const importFiles = useCallback(
    (files: File[]) => {
      if (desktop) {
        const paths = files.map((f) => desktop!.pathForFile(f)).filter(Boolean)
        if (paths.length) importPaths(paths)
        else setNotice({ kind: 'error', text: 'Those files have no location on disk. Drag them in from a folder instead.' })
        return
      }
      void runImport(async (status) => {
        const results: ImportResult[] = []
        const failed: LibraryImport['failed'] = []
        const zips = files.filter((f) => /\.zip$/i.test(f.name))
        const audio = files.filter((f) => !/\.zip$/i.test(f.name) && isAudioFile(f))
        for (const f of files) {
          if (!/\.zip$/i.test(f.name) && !isAudioFile(f)) failed.push({ name: f.name, reason: 'not an audio file or zip' })
        }
        for (const [i, zip] of zips.entries()) {
          try {
            const z = await readZipSong(zip)
            const which = zips.length > 1 ? ` (${i + 1} of ${zips.length})` : ''
            const r = await importStems(engine.ctx, z.sources, {
              meta: { name: z.name, ableton: z.ableton, artwork: z.artwork },
              onProgress: (d, t, n) => status(`Decoding ${z.name.title}${which}: ${d + 1} of ${t}, ${n}`),
            })
            r.skipped.push(...z.failed)
            results.push(r)
          } catch (e) {
            failed.push({ name: zip.name, reason: (e as Error).message })
          }
        }
        if (audio.length) {
          try {
            results.push(await importStems(engine.ctx, audio.map(fileSource), { onProgress: (d, t, n) => status(progressText('Decoding')(d, t, n)) }))
          } catch (e) {
            failed.push({ name: `${audio.length} files`, reason: (e as Error).message })
          }
        }
        return { results, failed }
      })
    },
    [runImport, importPaths],
  )

  const webPicker = useRef<HTMLInputElement>(null)
  /** Import Songs… (audio files and zips; folders too on a Mac) or Import Folder…. */
  const openImport = useCallback(
    (kind: 'files' | 'folders' = 'files') => {
      if (desktop) void desktop.library.pickImport(kind).then(importPaths)
      else webPicker.current?.click()
    },
    [importPaths],
  )

  /** L: repeat the section under the playhead until turned off; ⇧L: repeat it once. */
  const toggleCurrentLoop = (mode: LoopMode = 'forever') => {
    const cur = engine.currentSong
    if (cur?.sections.length) engine.toggleLoop(cur.sections[sectionIndexAt(cur, engine.position)].id, mode)
  }

  /** ⌘Z: in a text field it undoes the typing; anywhere else, the last library change. */
  const doUndo = (redoing: boolean) => {
    if (inTextField(document.activeElement)) document.execCommand(redoing ? 'redo' : 'undo')
    else void (redoing ? redo() : undo())
  }

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isAsking()) return
      const t = e.target as HTMLElement
      const mod = e.metaKey || e.ctrlKey
      // Undo / redo, also with the Setlists window open, where deleting happens. (The desktop
      // app's Edit menu sends these too.)
      if (mod && !e.altKey && (e.key.toLowerCase() === 'z' || (e.ctrlKey && e.key.toLowerCase() === 'y'))) {
        if (inTextField(t)) return
        e.preventDefault()
        void (e.shiftKey || e.key.toLowerCase() === 'y' ? redo() : undo())
        return
      }
      if (setlistsOpen) return
      if (inTextField(t) || t.closest('[role=slider]') || mod || e.altKey) return
      const cur = engine.currentSong
      if (e.code === 'Space') {
        e.preventDefault()
        engine.toggle()
      } else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key.toLowerCase() === 'f') engine.toggleFade()
      else if (e.key.toLowerCase() === 'l') toggleCurrentLoop(e.shiftKey ? 'once' : 'forever')
      else if (/^[1-9]$/.test(e.key) && cur) {
        const sec = cur.sections[Number(e.key) - 1]
        if (sec) engine.jumpToSection(sec.id, jumpMode)
      } else return
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, step, jumpMode, setlistsOpen])

  // Desktop: native menu commands. A ref keeps the handler current without resubscribing.
  const menuHandler = useRef<(cmd: MenuCommand) => void>(() => {})
  menuHandler.current = (cmd) => {
    if (cmd === 'import') openImport()
    else if (cmd === 'import-folder') openImport('folders')
    else if (cmd === 'undo' || cmd === 'redo') doUndo(cmd === 'redo')
    else if (cmd === 'toggle-play') engine.toggle()
    else if (cmd === 'prev') onPrev()
    else if (cmd === 'next') step(1)
    else if (cmd === 'fade') engine.toggleFade()
    else if (cmd === 'loop') toggleCurrentLoop()
    else if (cmd.startsWith('jump:')) setJumpMode(cmd.slice(5) as JumpMode)
    else if (cmd === 'toggle-setlist') setSetlistOpen((v) => !v)
    else if (cmd === 'setlists') setSetlistsOpen(true)
    else if (cmd === 'toggle-edit') setEditing(!editing)
    else if (cmd === 'song-settings') {
      if (currentId) setSettingsFor(currentId)
    }
    else if (cmd === 'outputs') setOutputsOpen(true)
    else if (cmd === 'pad') setLowerView('pad')
    else if (cmd === 'settings') setMenuOpen(true)
    else if (cmd === 'check-updates') {
      setMenuOpen(false)
      setUpdateOpen(true)
      void checkForUpdates()
    }
  }
  useEffect(() => desktop?.onMenu((cmd) => menuHandler.current(cmd)), [])

  // Drag & drop import.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setDragging(false)
      // A browser can't read a dropped folder's contents; the desktop app imports it by path.
      const folders = [...e.dataTransfer.items].some((it) => it.webkitGetAsEntry?.()?.isDirectory)
      if (!desktop && folders) {
        setNotice({ kind: 'error', text: 'Drop the zip instead: the web version can’t open folders (the desktop app can).' })
        return
      }
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) importFiles(desktop ? files : files.filter((f) => isAudioFile(f) || /\.zip$/i.test(f.name)))
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [importFiles])

  // After an edit to a song (or undoing / redoing one): update the engine if it's loaded,
  // refresh the views, and save it to its folder (desktop) shortly after the last change.
  useEffect(
    () =>
      onSongChanged((changed, kind) => {
        if (engine.currentSong === changed) {
          if (kind.clickSource) void engine.reloadSong()
          else if (kind.timing) engine.regenerateClick()
          engine.sectionsChanged()
        }
        setVersion((v) => v + 1)
        songChanged()
        if (!desktop || changed.source !== 'library') return
        window.clearTimeout(saveTimers.current.get(changed.id))
        saveTimers.current.set(
          changed.id,
          window.setTimeout(() => {
            desktop!.library.saveSong(recordFromSong(changed)).catch((e: Error) =>
              setNotice({ kind: 'error', text: `Couldn't save “${changed.title}”: ${e.message}` }),
            )
          }, 400),
        )
      }),
    [],
  )

  return (
    <div className={`app ${setlistOpen ? '' : 'no-setlist'} ${editing ? 'editing' : ''}`}>
      <Transport
        engine={engine}
        state={state}
        song={song}
        setlistName={setlist?.name ?? null}
        padOn={padOn}
        onPad={() => setPadOn(!padOn)}
        onBack={() => engine.seek(0)}
        editing={editing}
        onEdit={() => setEditing(!editing)}
        onSongSettings={() => currentId && setSettingsFor(currentId)}
        setlistsOpen={setlistsOpen}
        onSetlists={() => setSetlistsOpen((v) => !v)}
        onMore={() => setMenuOpen(true)}
        updateReady={!!updateReady}
      />
      {setlistOpen && (
        <Setlist
          songs={songs}
          currentId={currentId}
          editing={editing}
          playing={state.playing}
          songEnd={(id) => songEnd(setlist ?? undefined, id)}
          onSongEnd={(id, end) => setlist && setSongEnd(setlist.id, id, end)}
          onAddSong={(index, anchor) => setAddAt({ index: index ?? songs.length, anchor })}
          onSongSettings={setSettingsFor}
          onSelect={(id) => void selectSong(id)}
          onImport={importFiles}
          onImportClick={desktop ? () => openImport() : undefined}
          onRemove={(i) => setlist && removeFromSetlist(setlist.id, i)}
          onMove={(i, dir) => setlist && moveInSetlist(setlist.id, i, i + dir)}
          onDropSong={(id, index) => setlist && addToSetlist(setlist.id, [id], index)}
          onReorder={(from, to) => setlist && moveInSetlist(setlist.id, from, to)}
        />
      )}
      <Timeline
        engine={engine}
        state={state}
        song={song}
        peaks={currentId ? (peaks.current.get(currentId) ?? null) : null}
        jumpMode={jumpMode}
        version={version}
        editing={editing}
        edit={song ? (label, change) => editSong(song, label, change) : undefined}
      />
      <div className="lower">
        <Mixer
          engine={engine}
          state={state}
          song={song}
          view={lowerView}
          setView={setLowerView}
          pad={pad}
          padOn={padOn}
          setPadOn={setPadOn}
          padKey={padKey}
          playPadKey={(k) => {
            // A key picked by hand holds until another song is chosen (with Follow Song Key on).
            setPadKey(k)
            if (!padOn) setPadOn(true)
          }}
          autoPad={autoPad}
          setAutoPad={setAutoPad}
          padFollow={padFollow}
          setPadFollow={(v) => {
            setPadFollow(v)
            if (v && song) setPadKey(keyRoot(song.key))
          }}
          onOutputs={() => setOutputsOpen(true)}
          padSound={padSound}
          setPadSound={setPadSound}
          importedPads={importedPads}
          onImportPads={() => void importPads()}
          onDeletePad={desktop ? (x) => void deletePad(x) : undefined}
        />
      </div>
      {outputsOpen && <OutputsDialog engine={engine} state={state} onClose={() => setOutputsOpen(false)} />}
      {setlistsOpen && (
        <SetlistsMenu
          currentSongId={currentId}
          playing={state.playing}
          onLoadSong={(id) => void selectSong(id)}
          onImport={() => openImport()}
          onClose={() => setSetlistsOpen(false)}
        />
      )}
      {addAt && setlist && (
        <LibraryPicker
          anchor={addAt.anchor}
          setlistName={setlist.name}
          position={addAt.index}
          onAdd={(id) => {
            addToSetlist(setlist.id, [id], addAt.index)
            setAddAt(null)
          }}
          onImport={() => {
            setAddAt(null)
            openImport()
          }}
          onClose={() => setAddAt(null)}
        />
      )}
      {settingsFor && lib.songs[settingsFor] && (
        <SongSettingsDialog
          engine={engine}
          song={lib.songs[settingsFor]}
          loaded={settingsFor === currentId}
          edit={(label, change, field) => editSong(lib.songs[settingsFor], label, change, field)}
          onClose={() => setSettingsFor(null)}
        />
      )}
      {menuOpen && (
        <Menu
          link={link}
          setLink={setLink}
          onOutputs={() => {
            setMenuOpen(false)
            setOutputsOpen(true)
          }}
          jumpMode={jumpMode}
          setJumpMode={setJumpMode}
          fadeSeconds={fadeSeconds}
          setFadeSeconds={setFadeSeconds}
          libraryRoot={lib.root}
          onRevealLibrary={desktop ? () => void desktop!.library.reveal() : undefined}
          update={
            desktop
              ? {
                  version: updates.version,
                  ready: updateReady,
                  onOpen: () => {
                    setMenuOpen(false)
                    setUpdateOpen(true)
                    if (updates.status !== 'available') void checkForUpdates()
                  },
                }
              : undefined
          }
          onClose={() => setMenuOpen(false)}
        />
      )}
      {updateOpen && <UpdateDialog playing={state.playing} onClose={() => setUpdateOpen(false)} />}
      {/* The web version's picker for pad zips (IMPORT in the Pad Player). */}
      <input
        ref={padPicker}
        type="file"
        accept=".zip,application/zip,.wav,.wave,.aif,.aiff,audio/wav"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void importPadFiles(files)
        }}
      />
      {/* The web version's file picker, for Import in the Setlists menu. */}
      <input
        ref={webPicker}
        type="file"
        accept="audio/*,.wav,.wave,.bwf,.rf64,.mp3,.m4a,.aif,.aiff,.flac,.ogg,.zip,application/zip"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) importFiles(files)
        }}
      />
      {loading && (
        <div className="overlay">
          <div className="spinner" />
          {loading}
        </div>
      )}
      {notice && (
        <div className={`toast ${notice.kind}`} onClick={() => setNotice(null)} role="status">
          {notice.text}
        </div>
      )}
      {history.note && (
        <div className="undo-note" key={history.note.seq} role="status">
          <span>{history.note.text}</span>
          {history.note.undoable && history.undoLabel && (
            <button className="small" onClick={() => void undo()}>
              Undo
            </button>
          )}
        </div>
      )}
      {dragging && <div className="overlay drop">Drop stems to create a new song</div>}
      <AskHost />
      <ContextMenuHost />
    </div>
  )
}
