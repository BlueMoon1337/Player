import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, type JumpMode } from './audio/engine'
import { importStems, isAudioFile } from './audio/importer'
import { PadPlayer } from './audio/pad'
import { computePeaks } from './audio/peaks'
import { demoSongs, renderDemoStems } from './audio/synth'
import { type Song, sectionIndexAt } from './audio/types'
import { Mixer } from './components/Mixer'
import { BusesPanel, EditPanel, Menu, PadPanel } from './components/Panels'
import { Setlist } from './components/Setlist'
import { Timeline } from './components/Timeline'
import { Transport } from './components/Transport'

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

export default function App() {
  const state = useSyncExternalStore(engine.subscribe, engine.getState)
  const [songs, setSongs] = useState<Song[]>(() => demoSongs())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null)
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

  useEffect(() => {
    if (notice?.kind !== 'info') return
    const t = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [notice])

  const song = songs.find((s) => s.id === currentId) ?? null

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
        // Demo stems can be re-rendered at any time, so only keep the current one in memory.
        for (const s of songs) if (s.source === 'demo' && s.id !== id) s.stems = []
        setLoading(null)
      }
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

  // Load the first song on start.
  useEffect(() => {
    if (!currentId && songs.length) void selectSong(songs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const onImport = useCallback(
    async (files: File[]) => {
      setNotice(null)
      setLoading('Decoding stems…')
      try {
        const { song: s, skipped, notes } = await importStems(engine.ctx, files, (done, total, name) =>
          setLoading(total > 1 ? `Decoding ${done + 1} of ${total}: ${name}` : `Decoding ${name}…`),
        )
        setSongs((prev) => [...prev, s])
        setLoading(null)
        peaks.current.set(s.id, computePeaks(s.stems, s.duration))
        engine.pause()
        engine.load(s)
        setCurrentId(s.id)
        setEditMode(true)
        let text = `Imported ${s.stems.length} stem${s.stems.length === 1 ? '' : 's'}`
        if (notes.length) text += ` · read ${notes.join(', ')} from the files`
        if (skipped.length) text += `. Skipped ${skipped.map((f) => `${f.name} (${f.reason})`).join(', ')}`
        setNotice({ kind: skipped.length ? 'warn' : 'info', text })
      } catch (e) {
        setLoading(null)
        setNotice({ kind: 'error', text: `Couldn't import: ${(e as Error).message}` })
      }
    },
    [],
  )

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
      else if (e.key.toLowerCase() === 'l' && cur) {
        engine.toggleLoop(cur.sections[sectionIndexAt(cur, engine.position)].id)
      } else if (/^[1-9]$/.test(e.key) && cur) {
        const sec = cur.sections[Number(e.key) - 1]
        if (sec) engine.jumpToSection(sec.id, jumpMode)
      } else return
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, step, jumpMode])

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
      const files = [...(e.dataTransfer?.files ?? [])].filter(isAudioFile)
      if (files.length) void onImport(files)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [onImport])

  const bump = () => {
    setVersion((v) => v + 1)
    setSongs((s) => [...s])
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
          onImport={(f) => void onImport(f)}
          onRemove={(id) => {
            if (id === currentId) engine.pause()
            setSongs((prev) => prev.filter((s) => s.id !== id))
            peaks.current.delete(id)
          }}
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
