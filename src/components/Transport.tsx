import { useEffect, useRef, useState } from 'react'
import type { Engine, EngineState } from '../audio/engine'
import { type Song, formatTime } from '../audio/types'

interface Props {
  engine: Engine
  state: EngineState
  song: Song | null
  /** The current setlist's name, shown above the transport buttons. */
  setlistName: string | null
  padOn: boolean
  onPad: () => void
  onBack: () => void
  /** Edit mode ("Setlist / Song Map", as in Playback). */
  editing: boolean
  onEdit: () => void
  /** The loaded song's settings (title, key, tempo, click). */
  onSongSettings: () => void
  setlistsOpen: boolean
  onSetlists: () => void
  onMore: () => void
  /** A newer version is ready to install: the More button gets a dot. */
  updateReady?: boolean
}

/** "00:00": minutes and seconds, always two digits each, for the big display. */
function bigTime(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Time display: where the song is now (large), and its start / end points (small). */
function TimeDisplay({ engine, song }: { engine: Engine; song: Song | null }) {
  const el = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let last = ''
    const loop = () => {
      const text = bigTime(engine.position)
      if (text !== last && el.current) el.current.textContent = last = text
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [engine])
  return (
    <div className="t-tile t-time" aria-label="Song position">
      <span className="t-time-big" ref={el}>
        00:00
      </span>
      <span className="t-time-small">{song ? `${formatTime(0)} / ${formatTime(song.duration)}` : '–:–– / –:––'}</span>
    </div>
  )
}

/** EDIT / DONE: a click toggles edit mode; holding it (or right-clicking) offers the edit choices. */
function EditButton({ editing, onEdit, onSongSettings }: Pick<Props, 'editing' | 'onEdit' | 'onSongSettings'>) {
  const [choosing, setChoosing] = useState(false)
  const holdTimer = useRef<number | undefined>(undefined)
  const held = useRef(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!choosing) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setChoosing(false)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
    }
  }, [choosing])

  const choices = [
    { label: 'Setlist / Song Map', hint: 'Reorder songs, add and delete sections', on: editing, run: () => !editing && onEdit() },
    { label: 'Song Settings…', hint: 'Title, key, tempo, click', on: false, run: onSongSettings },
  ]
  return (
    <div className="t-edit-wrap" ref={wrap}>
      <button
        className={`t-tile t-btn t-edit ${editing ? 'on' : ''}`}
        title={editing ? 'Done editing' : 'Edit the setlist and song map (press and hold for more)'}
        aria-haspopup="menu"
        onPointerDown={() => {
          held.current = false
          holdTimer.current = window.setTimeout(() => {
            held.current = true
            setChoosing(true)
          }, 450)
        }}
        onPointerUp={() => window.clearTimeout(holdTimer.current)}
        onPointerLeave={() => window.clearTimeout(holdTimer.current)}
        onContextMenu={(e) => {
          e.preventDefault()
          window.clearTimeout(holdTimer.current)
          setChoosing(true)
        }}
        onClick={() => {
          if (!held.current) onEdit()
          held.current = false
        }}
      >
        {editing ? 'DONE' : 'EDIT'}
      </button>
      {choosing && (
        <div className="t-edit-menu" role="menu">
          {choices.map((c) => (
            <button
              key={c.label}
              role="menuitem"
              className={c.on ? 'on' : ''}
              onClick={() => {
                setChoosing(false)
                c.run()
              }}
            >
              <b>{c.label}</b>
              <span>{c.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Transport(p: Props) {
  const { engine, state, song } = p
  const canPlay = !!song && song.stems.length > 0
  return (
    <header className="transport">
      <div className="t-setlist-name" title="Current setlist">
        {p.setlistName ?? ''}
      </div>
      <div className="t-row">
        <div className="t-tile t-tempo" aria-label="Tempo and time signature">
          {song ? (
            <>
              <span className="t-tempo-bpm">{Math.round(song.bpm * 10) / 10}</span>
              <span className="t-tempo-sig">
                {song.timeSig[0]}/{song.timeSig[1]}
              </span>
            </>
          ) : null}
        </div>
        <TimeDisplay engine={engine} song={song} />
        <button className={`t-tile t-btn t-pad ${p.padOn ? 'on' : ''}`} onClick={p.onPad} title="Ambient pad on / off">
          PAD
        </button>
        <button className="t-tile t-btn t-wide" onClick={p.onBack} disabled={!song} title="Back to start (←)" aria-label="Back to start">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M8 7v18" />
            <path d="M24 7v18L12 16z" />
          </svg>
        </button>
        <button
          className={`t-tile t-btn t-play ${state.playing ? 'playing' : ''}`}
          onClick={() => engine.toggle()}
          disabled={!canPlay}
          title="Play / pause (Space)"
          aria-label={state.playing ? 'Pause' : 'Play'}
        >
          {state.playing ? (
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M10 7v18M22 7v18" />
            </svg>
          ) : (
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M10 6v20l16-10z" />
            </svg>
          )}
        </button>
        <button
          className={`t-tile t-btn t-wide t-fade ${state.fade ? `fading-${state.fade}` : ''}`}
          onClick={() => engine.toggleFade()}
          disabled={!canPlay}
          title={state.playing ? 'Fade tracks out (F)' : 'Fade tracks in (F)'}
          aria-label={state.playing ? 'Fade out' : 'Fade in'}
        >
          <svg viewBox="0 0 32 32" aria-hidden="true">
            {state.playing ? <path d="M5 9c5 0 8 14 22 14H5z" /> : <path d="M27 9c-5 0-8 14-22 14h22z" />}
          </svg>
        </button>
        <EditButton editing={p.editing} onEdit={p.onEdit} onSongSettings={p.onSongSettings} />
        <button
          className={`t-tile t-btn t-icon ${p.setlistsOpen ? 'on' : ''}`}
          onClick={p.onSetlists}
          title="Setlists and library"
          aria-label="Setlists menu"
        >
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M5 9h13M5 14h13M5 19h9M5 24h9" />
            <path d="M22 22V9l6 2" />
            <circle cx="20" cy="22.5" r="2.5" />
          </svg>
        </button>
        <button
          className={`t-tile t-btn t-icon ${p.updateReady ? 'update-ready' : ''}`}
          onClick={p.onMore}
          title={p.updateReady ? 'More (an update is ready)' : 'More: settings, updates and more'}
          aria-label="More menu"
        >
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7 10h18M7 16h18M7 22h18" />
          </svg>
          {p.updateReady && <span className="update-dot" />}
        </button>
      </div>
    </header>
  )
}
