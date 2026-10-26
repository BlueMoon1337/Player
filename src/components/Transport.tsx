import { useEffect, useRef } from 'react'
import type { Engine, EngineState } from '../audio/engine'
import { type Song, formatTime } from '../audio/types'

interface Props {
  engine: Engine
  state: EngineState
  song: Song | null
  padOn: boolean
  onPad: () => void
  onPrev: () => void
  editMode: boolean
  onEdit: () => void
  setlistOpen: boolean
  onSetlist: () => void
  onMenu: () => void
}

function Clock({ engine, song }: { engine: Engine; song: Song | null }) {
  const el = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let last = ''
    const loop = () => {
      const text = formatTime(engine.position)
      if (text !== last && el.current) el.current.textContent = last = text
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [engine])
  return (
    <div className="clock">
      <span ref={el}>0:00</span>
      <span className="clock-sep">/</span>
      <span className="clock-total">{formatTime(song?.duration ?? 0)}</span>
    </div>
  )
}

export function Transport(p: Props) {
  const { engine, state, song } = p
  return (
    <header className="transport">
      <div className="transport-left">
        <div className="tempo">
          <span className="tempo-bpm">{song ? Math.round(song.bpm * 10) / 10 : '—'}</span>
          <span className="tempo-label">BPM</span>
        </div>
        <div className="tempo">
          <span className="tempo-bpm">{song ? `${song.timeSig[0]}/${song.timeSig[1]}` : '—'}</span>
          <span className="tempo-label">{song?.key ?? ''}</span>
        </div>
        <Clock engine={engine} song={song} />
        <button className={`pill ${p.padOn ? 'on' : ''}`} onClick={p.onPad} title="Toggle pad">
          PAD
        </button>
      </div>
      <div className="transport-center">
        <button className="tbtn" onClick={p.onPrev} title="Back to start / previous song (←)">
          <svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
        </button>
        <button
          className={`tbtn play ${state.playing ? 'playing' : ''}`}
          onClick={() => engine.toggle()}
          disabled={!song || song.stems.length === 0}
          title="Play / pause (Space)"
        >
          {state.playing ? (
            <svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" /></svg>
          )}
        </button>
        <button
          className={`tbtn ${state.fading ? 'fading' : ''}`}
          onClick={() => engine.fadeOut()}
          disabled={!state.playing}
          title="Fade out (F)"
        >
          <svg viewBox="0 0 24 24"><path d="M3 6l18 6-18 6z" opacity=".35" /><path d="M3 6v12l9-6z" /></svg>
          <span className="tbtn-label">FADE</span>
        </button>
      </div>
      <div className="transport-right">
        <button className={`pill ${p.editMode ? 'on edit' : ''}`} onClick={p.onEdit}>
          EDIT
        </button>
        <button className={`icon-btn ${p.setlistOpen ? 'on' : ''}`} onClick={p.onSetlist} title="Show / hide setlist">
          <svg viewBox="0 0 24 24"><path d="M3 5h18v2H3zM3 11h18v2H3zM3 17h12v2H3z" /></svg>
        </button>
        <button className="icon-btn" onClick={p.onMenu} title="Menu">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </div>
    </header>
  )
}
