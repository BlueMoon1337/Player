import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, type JumpMode } from './audio/engine'
import { type ImportResult, fileSource, importStems, isAudioFile } from './audio/importer'
import { PadPlayer } from './audio/pad'
import { computePeaks } from './audio/peaks'
import { demoSongs, renderDemoStems } from './audio/synth'
import { type Song, sectionIndexAt } from './audio/types'
import { Mixer } from './components/Mixer'
import { BusesPanel, EditPanel, Menu, PadPanel } from './components/Panels'
import { Setlist } from './components/Setlist'
import { Timeline } from './components/Timeline'
import { Transport } from './components/Transport'
import { type MenuCommand, desktop } from './platform'
import { importIntoLibrary, loadSongStems, recordFromSong, songFromRecord } from './platform/library'

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

export default function App() {
  const state = useSyncExternalStore(engine.subscribe, engine.getState)
  // On desktop the setlist comes from the library folder; the web version starts with the demos.
  const [songs, setSongs] = useState<Song[]>(() => (desktop ? [] : demoSongs()))
  const [ready, setReady] = useState(!desktop)
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [version, setVersion] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [setlistOpen, setSetlistOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
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
  const saveTimer = useRef<number | undefined>(undefined)

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

  // Desktop: load the library and setlist from disk.
  useEffect(() => {
    if (!desktop) return
    desktop.library
      .load()
      .then(({ root, songs: records, setlist }) => {
        setLibraryRoot(root)
        const demos = demoSongs()
        const all = new Map<string, Song>([...demos, ...records.map(songFromRecord)].map((s) => [s.id, s]))
        const order = setlist ?? demos.map((d) => d.id)
        const list = order.map((id) => all.get(id)).filter((s): s is Song => !!s)
        // Songs added outside a saved setlist (e.g. copied into the folder) go on the end.
        for (const r of records) if (!order.includes(r.id)) list.push(all.get(r.id)!)
        setSongs(list)
      })
      .catch((e: Error) => setNotice({ kind: 'error', text: `Couldn't open the song library: ${e.message}` }))
      .finally(() => setReady(true))
  }, [])

  // Desktop: persist setlist order.
  const setlistKey = songs.map((s) => s.id).join('|')
  useEffect(() => {
    if (!desktop || !ready) return
    desktop.library.saveSetlist(setlistKey ? setlistKey.split('|') : []).catch(() => {})
  }, [setlistKey, ready])

  // Desktop: keep the display awake and guard quitting while audio runs.
  useEffect(() => {
    desktop?.setActive(state.playing || padOn)
  }, [state.playing, padOn])

  useEffect(() => {
    desktop?.setMenuState({ jumpMode, setlistOpen, editMode })
  }, [jumpMode, setlistOpen, editMode])

  const song = songs.find((s) => s.id === currentId) ?? null

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

  const selectSong = useCallback(
    async (id: string, autoplay = false) => {
      const target = songs.find((s) => s.id === id)
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
      for (const s of songs) if (s.id !== id && s.source !== 'user') s.stems = []
      if (!peaks.current.has(id)) peaks.current.set(id, computePeaks(target.stems, target.duration))
      engine.load(target)
      setCurrentId(id)
      engine.sendMidi([0xc0, songs.indexOf(target) & 0x7f])
      if (padFollow) setPadKey(target.key)
      if (autoplay) await engine.play()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [songs, padFollow],
  )

  // Load the first song once the setlist is known.
  useEffect(() => {
    if (ready && !currentId && songs.length) void selectSong(songs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

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
      setSongs((prev) => [...prev, s])
      peaks.current.set(s.id, computePeaks(s.stems, s.duration))
      engine.pause()
      engine.load(s)
      setCurrentId(s.id)
      setEditMode(true)
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

  const openImport = useCallback(() => {
    if (desktop) void desktop.library.pickStems().then(importPaths)
  }, [importPaths])

  const toggleCurrentLoop = () => {
    const cur = engine.currentSong
    if (cur) engine.toggleLoop(cur.sections[sectionIndexAt(cur, engine.position)].id)
  }

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, select, textarea, [role=slider]') || e.metaKey || e.ctrlKey || e.altKey) return
      const cur = engine.currentSong
      if (e.code === 'Space') {
        e.preventDefault()
        engine.toggle()
      } else if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key.toLowerCase() === 'f') engine.fadeOut()
      else if (e.key.toLowerCase() === 'l') toggleCurrentLoop()
      else if (/^[1-9]$/.test(e.key) && cur) {
        const sec = cur.sections[Number(e.key) - 1]
        if (sec) engine.jumpToSection(sec.id, jumpMode)
      } else return
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, step, jumpMode])

  // Desktop: native menu commands. A ref keeps the handler current without resubscribing.
  const menuHandler = useRef<(cmd: MenuCommand) => void>(() => {})
  menuHandler.current = (cmd) => {
    if (cmd === 'import') openImport()
    else if (cmd === 'toggle-play') engine.toggle()
    else if (cmd === 'prev') onPrev()
    else if (cmd === 'next') step(1)
    else if (cmd === 'fade') engine.fadeOut()
    else if (cmd === 'loop') toggleCurrentLoop()
    else if (cmd.startsWith('jump:')) setJumpMode(cmd.slice(5) as JumpMode)
    else if (cmd === 'toggle-setlist') setSetlistOpen((v) => !v)
    else if (cmd === 'toggle-edit') setEditMode((v) => !v)
    else if (cmd === 'outputs' || cmd === 'pad') {
      setEditMode(false)
      setPanel(cmd === 'outputs' ? 'buses' : 'pad')
    } else if (cmd === 'settings') setMenuOpen(true)
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

  const bump = () => {
    setVersion((v) => v + 1)
    setSongs((s) => [...s])
    // Desktop: save edits to the song's folder shortly after the last change.
    if (desktop && song?.source === 'library') {
      const target = song
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        desktop!.library.saveSong(recordFromSong(target)).catch((e: Error) =>
          setNotice({ kind: 'error', text: `Couldn't save “${target.title}”: ${e.message}` }),
        )
      }, 400)
    }
  }

  const removeSong = async (id: string) => {
    const s = songs.find((x) => x.id === id)
    if (!s) return
    if (s.source === 'library') {
      if (!window.confirm(`Move “${s.title}” and its stems to the Trash?`)) return
      try {
        await desktop!.library.deleteSong(id)
      } catch (e) {
        setNotice({ kind: 'error', text: `Couldn't remove “${s.title}”: ${(e as Error).message}` })
        return
      }
    }
    if (id === currentId) engine.pause()
    setSongs((prev) => prev.filter((x) => x.id !== id))
    peaks.current.delete(id)
  }

  return (
    <div className={`app ${setlistOpen ? '' : 'no-setlist'}`}>
      <Transport
        engine={engine}
        state={state}
        song={song}
        padOn={padOn}
        onPad={() => setPadOn(!padOn)}
        onPrev={onPrev}
        editMode={editMode}
        onEdit={() => setEditMode(!editMode)}
        setlistOpen={setlistOpen}
        onSetlist={() => setSetlistOpen(!setlistOpen)}
        onMenu={() => setMenuOpen(true)}
      />
      {setlistOpen && (
        <Setlist
          songs={songs}
          currentId={currentId}
          editMode={editMode}
          onSelect={(id) => void selectSong(id)}
          onImport={importFiles}
          onImportClick={desktop ? openImport : undefined}
          onRemove={(id) => void removeSong(id)}
          onMove={(id, dir) =>
            setSongs((prev) => {
              const i = prev.findIndex((s) => s.id === id)
              const j = i + dir
              if (j < 0 || j >= prev.length) return prev
              const next = [...prev]
              ;[next[i], next[j]] = [next[j], next[i]]
              return next
            })
          }
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
        {editMode && song && <EditPanel engine={engine} song={song} onChange={bump} />}
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
            if (p) setEditMode(false)
          }}
          link={link}
          setLink={setLink}
          padOn={padOn}
        />
      </div>
      {menuOpen && (
        <Menu
          jumpMode={jumpMode}
          setJumpMode={setJumpMode}
          fadeSeconds={fadeSeconds}
          setFadeSeconds={setFadeSeconds}
          libraryRoot={libraryRoot}
          onRevealLibrary={desktop ? () => void desktop!.library.reveal() : undefined}
          onClose={() => setMenuOpen(false)}
        />
      )}
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
      {dragging && <div className="overlay drop">Drop stems to create a new song</div>}
    </div>
  )
}
