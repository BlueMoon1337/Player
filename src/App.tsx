import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, type JumpMode } from './audio/engine'
import { type ImportResult, fileSource, importStems, isAudioFile } from './audio/importer'
import { PadPlayer } from './audio/pad'
import { computePeaks } from './audio/peaks'
import { renderDemoStems } from './audio/synth'
import { type Song, sectionIndexAt } from './audio/types'
import { AskHost, ContextMenuHost, isAsking } from './components/Ask'
import { Mixer } from './components/Mixer'
import { BusesPanel, EditPanel, Menu, PadPanel } from './components/Panels'
import { Setlist } from './components/Setlist'
import { SetlistsMenu, confirmDeleteSong } from './components/SetlistsMenu'
import { Timeline } from './components/Timeline'
import { type EditMode, Transport } from './components/Transport'
import { UpdateDialog } from './components/UpdateDialog'
import { clearNote, redo, undo, useHistory } from './library/history'
import { editSong, onSongChanged } from './library/songEdits'
import {
  currentSetlist,
  importSongs,
  loadLibrary,
  moveInSetlist,
  onSaveError,
  removeFromSetlist,
  setlistSongs,
  songChanged,
  useLibrary,
} from './library/store'
import { type MenuCommand, desktop } from './platform'
import { importIntoLibrary, loadSongStems, recordFromSong } from './platform/library'
import { checkForUpdates, startUpdateChecks, useUpdates } from './platform/updates'

// One audio graph for the lifetime of the page.
const engine = new Engine()
const pad = new PadPlayer(engine.ctx)

const SETTINGS_KEY = 'player.settings.v1'

function loadSettings(): { jumpMode: JumpMode; fadeSeconds: number; link: boolean } {
  const defaults = { jumpMode: 'bar' as JumpMode, fadeSeconds: 4, link: false }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return defaults
  }
}

type Notice = { kind: 'info' | 'warn' | 'error'; text: string }

function importNotice({ song, skipped, notes }: ImportResult): Notice {
  let text = `Imported ${song.stems.length} stem${song.stems.length === 1 ? '' : 's'}`
  if (notes.length) text += ` · read ${notes.join(', ')} from the files`
  if (skipped.length) text += `. Skipped ${skipped.map((f) => `${f.name} (${f.reason})`).join(', ')}`
  return { kind: skipped.length ? 'warn' : 'info', text }
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
  const [editMode, setEditMode] = useState<EditMode | null>(null)
  const lastEditMode = useRef<EditMode>('song')
  const [setlistOpen, setSetlistOpen] = useState(true)
  const [setlistsOpen, setSetlistsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const updates = useUpdates()
  const updateReady = updates.status === 'available' && updates.found ? updates.found.version : null
  const [panel, setPanel] = useState<'buses' | 'pad' | null>(null)
  const [padOn, setPadOnState] = useState(false)
  const [padKey, setPadKeyState] = useState('C')
  const [padFollow, setPadFollow] = useState(true)
  const [dragging, setDragging] = useState(false)
  const initial = useMemo(loadSettings, [])
  const [jumpMode, setJumpMode] = useState<JumpMode>(initial.jumpMode)
  const [fadeSeconds, setFadeSeconds] = useState(initial.fadeSeconds)
  const [link, setLink] = useState(initial.link)
  const peaks = useRef(new Map<string, Float32Array>())
  const saveTimers = useRef(new Map<string, number>())

  const chooseEditMode = (mode: EditMode | null) => {
    if (mode) lastEditMode.current = mode
    setEditMode(mode)
    if (mode) setPanel(null)
  }

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ jumpMode, fadeSeconds, link }))
    } catch {
      /* storage unavailable */
    }
  }, [jumpMode, fadeSeconds, link])

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
      editMode: editMode !== null,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    })
  }, [jumpMode, setlistOpen, editMode, history.undoLabel, history.redoLabel])

  const song = (currentId && lib.songs[currentId]) || null

  useEffect(() => {
    document.title = song ? `${song.title} — Player` : 'Player'
  }, [song?.title])

  const setPadOn = (on: boolean) => {
    setPadOnState(on)
    void pad.setOn(on)
  }
  const setPadKey = (k: string) => {
    setPadKeyState(k)
    pad.setKey(k)
  }

  /** Loads a library song into the player (rendering or reading its stems first). */
  const selectSong = useCallback(
    async (id: string, autoplay = false) => {
      const target = lib.songs[id]
      if (!target) return
      engine.pause()
      if (target.stems.length === 0 && target.source === 'demo') {
        setLoading(`Rendering “${target.title}”…`)
        // Let the overlay paint before the synchronous render.
        await new Promise((r) => setTimeout(r, 30))
        target.stems = renderDemoStems(engine.ctx, target)
        setLoading(null)
      } else if (target.stems.length === 0 && target.source === 'library') {
        setLoading(`Loading “${target.title}”…`)
        const { stems, missing } = await loadSongStems(engine.ctx, target, (d, t, n) =>
          setLoading(progressText('Loading')(d, t, n)),
        )
        target.stems = stems
        setLoading(null)
        if (missing.length) {
          setNotice({ kind: 'warn', text: `“${target.title}”: couldn't load ${missing.join(', ')}` })
        }
      }
      // Demo and library stems can be reloaded at any time, so only keep the current song in memory.
      for (const s of Object.values(lib.songs)) if (s.id !== id && s.source !== 'user') s.stems = []
      if (!peaks.current.has(id)) peaks.current.set(id, computePeaks(target.stems, target.duration))
      engine.load(target)
      setCurrentId(id)
      engine.sendMidi([0xc0, Math.max(0, songs.indexOf(target)) & 0x7f])
      if (padFollow) setPadKey(target.key)
      if (autoplay) await engine.play()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lib, songs, padFollow],
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

  // Linked setlist: roll into the next song when one ends.
  useEffect(
    () =>
      engine.onEnded(() => {
        if (!link) return
        const i = songs.findIndex((s) => s.id === currentId)
        if (i >= 0 && i + 1 < songs.length) void selectSong(songs[i + 1].id, true)
      }),
    [link, songs, currentId, selectSong],
  )

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

  const runImport = useCallback(async (job: (progress: (d: number, t: number, n: string) => void) => Promise<ImportResult>) => {
    setNotice(null)
    setLoading('Importing stems…')
    try {
      const result = await job((d, t, n) => setLoading(progressText('Decoding')(d, t, n)))
      const s = result.song
      // Into the library, and onto the end of the current setlist.
      importSongs([s])
      peaks.current.set(s.id, computePeaks(s.stems, s.duration))
      engine.pause()
      engine.load(s)
      setCurrentId(s.id)
      chooseEditMode('song')
      setNotice(importNotice(result))
    } catch (e) {
      setNotice({ kind: 'error', text: `Couldn't import: ${(e as Error).message}` })
    } finally {
      setLoading(null)
    }
  }, [])

  /** Desktop: stems are copied into the library and saved with the song. */
  const importPaths = useCallback(
    (paths: string[]) => {
      if (desktop && paths.length) void runImport((p) => importIntoLibrary(desktop!, engine.ctx, paths, p))
    },
    [runImport],
  )

  /** Web: decoded in memory only. On desktop, dropped files are imported by path. */
  const importFiles = useCallback(
    (files: File[]) => {
      if (desktop) {
        const paths = files.map((f) => desktop!.pathForFile(f)).filter(Boolean)
        if (paths.length) importPaths(paths)
        else setNotice({ kind: 'error', text: 'Those files have no location on disk. Drag them in from a folder instead.' })
        return
      }
      void runImport((p) => importStems(engine.ctx, files.map(fileSource), { onProgress: p }))
    },
    [runImport, importPaths],
  )

  const webPicker = useRef<HTMLInputElement>(null)
  const openImport = useCallback(() => {
    if (desktop) void desktop.library.pickStems().then(importPaths)
    else webPicker.current?.click()
  }, [importPaths])

  const toggleCurrentLoop = () => {
    const cur = engine.currentSong
    if (cur) engine.toggleLoop(cur.sections[sectionIndexAt(cur, engine.position)].id)
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
      else if (e.key.toLowerCase() === 'l') toggleCurrentLoop()
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
    else if (cmd === 'undo' || cmd === 'redo') doUndo(cmd === 'redo')
    else if (cmd === 'toggle-play') engine.toggle()
    else if (cmd === 'prev') onPrev()
    else if (cmd === 'next') step(1)
    else if (cmd === 'fade') engine.toggleFade()
    else if (cmd === 'loop') toggleCurrentLoop()
    else if (cmd.startsWith('jump:')) setJumpMode(cmd.slice(5) as JumpMode)
    else if (cmd === 'toggle-setlist') setSetlistOpen((v) => !v)
    else if (cmd === 'setlists') setSetlistsOpen(true)
    else if (cmd === 'toggle-edit') chooseEditMode(editMode ? null : lastEditMode.current)
    else if (cmd === 'outputs' || cmd === 'pad') {
      chooseEditMode(null)
      setPanel(cmd === 'outputs' ? 'buses' : 'pad')
    } else if (cmd === 'settings') setMenuOpen(true)
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
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) importFiles(desktop ? files : files.filter(isAudioFile))
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
      onSongChanged((changed, timing) => {
        if (engine.currentSong === changed) {
          if (timing) engine.regenerateClick()
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

  const deleteFromLibrary = (s: Song) => void confirmDeleteSong(s, { playingNow: state.playing && s.id === currentId })

  return (
    <div className={`app ${setlistOpen ? '' : 'no-setlist'}`}>
      <Transport
        engine={engine}
        state={state}
        song={song}
        setlistName={setlist?.name ?? null}
        padOn={padOn}
        onPad={() => setPadOn(!padOn)}
        onBack={() => engine.seek(0)}
        editMode={editMode}
        onEdit={() => chooseEditMode(editMode ? null : lastEditMode.current)}
        onEditMode={(m) => chooseEditMode(editMode === m ? null : m)}
        setlistsOpen={setlistsOpen}
        onSetlists={() => setSetlistsOpen((v) => !v)}
        onMore={() => setMenuOpen(true)}
        updateReady={!!updateReady}
      />
      {setlistOpen && (
        <Setlist
          songs={songs}
          currentId={currentId}
          editing={editMode === 'setlist'}
          onSelect={(id) => void selectSong(id)}
          onImport={importFiles}
          onImportClick={desktop ? openImport : undefined}
          onRemove={(i) => setlist && removeFromSetlist(setlist.id, i)}
          onMove={(i, dir) => setlist && moveInSetlist(setlist.id, i, i + dir)}
          onDelete={deleteFromLibrary}
        />
      )}
      <Timeline
        engine={engine}
        state={state}
        song={song}
        peaks={currentId ? (peaks.current.get(currentId) ?? null) : null}
        jumpMode={jumpMode}
        version={version}
      />
      <div className="lower">
        {editMode === 'song' && song && (
          <EditPanel engine={engine} song={song} edit={(label, change, field) => editSong(song, label, change, field)} />
        )}
        {!editMode && panel === 'buses' && <BusesPanel engine={engine} state={state} />}
        {!editMode && panel === 'pad' && (
          <PadPanel
            pad={pad}
            padOn={padOn}
            setPadOn={setPadOn}
            followSong={padFollow}
            setFollowSong={(v) => {
              setPadFollow(v)
              if (v && song) setPadKey(song.key)
            }}
            padKey={padKey}
            setPadKey={setPadKey}
          />
        )}
        <Mixer
          engine={engine}
          state={state}
          panel={panel}
          setPanel={(p) => {
            setPanel(p)
            if (p) setEditMode(null)
          }}
          link={link}
          setLink={setLink}
          padOn={padOn}
        />
      </div>
      {setlistsOpen && (
        <SetlistsMenu
          currentSongId={currentId}
          playing={state.playing}
          onLoadSong={(id) => void selectSong(id)}
          onImport={openImport}
          onClose={() => setSetlistsOpen(false)}
        />
      )}
      {menuOpen && (
        <Menu
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
      {/* The web version's file picker, for Import in the Setlists menu. */}
      <input
        ref={webPicker}
        type="file"
        accept="audio/*,.wav,.wave,.bwf,.rf64,.mp3,.m4a,.aif,.aiff,.flac,.ogg"
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
