import { useEffect, useRef } from 'react'
import type { Engine, EngineState, JumpMode } from '../audio/engine'
import { type Song, sectionColor, sectionEnd, sectionIndexAt } from '../audio/types'

interface Props {
  engine: Engine
  state: EngineState
  song: Song | null
  peaks: Float32Array | null
  jumpMode: JumpMode
  /** Bumped when the song's sections change so the canvas redraws. */
  version: number
}

export function Timeline({ engine, state, song, peaks, jumpMode, version }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const labels = useRef<HTMLDivElement>(null)

  // Static layer: section bands + waveform. Redrawn on resize or song change.
  useEffect(() => {
    const cv = canvas.current
    const el = wrap.current
    if (!cv || !el) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      const g = cv.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      if (!song) return
      const x = (t: number) => (t / song.duration) * w
      song.sections.forEach((s, i) => {
        const x0 = x(s.start)
        const x1 = x(sectionEnd(song, i))
        g.fillStyle = sectionColor(s.name) + '2a'
        g.fillRect(x0, 0, x1 - x0, h)
        g.fillStyle = sectionColor(s.name)
        g.fillRect(x0, 0, 2, h)
      })
      if (peaks) {
        const mid = h / 2
        song.sections.forEach((s, i) => {
          const x0 = Math.floor(x(s.start))
          const x1 = Math.ceil(x(sectionEnd(song, i)))
          g.fillStyle = sectionColor(s.name) + 'd0'
          for (let px = x0; px < x1; px++) {
            const b = Math.floor((px / w) * peaks.length)
            const b2 = Math.max(b + 1, Math.floor(((px + 1) / w) * peaks.length))
            let v = 0
            for (let k = b; k < b2 && k < peaks.length; k++) v = Math.max(v, peaks[k])
            const amp = Math.max(0.5, v * (h * 0.42))
            g.fillRect(px, mid - amp, 1, amp * 2)
          }
        })
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [song, peaks, version])

  // Playhead + active section highlight run on rAF without re-rendering React.
  useEffect(() => {
    let raf = 0
    let lastIdx = -1
    const loop = () => {
      if (song && playhead.current) {
        const pos = engine.position
        playhead.current.style.left = `${(pos / song.duration) * 100}%`
        const idx = sectionIndexAt(song, pos)
        if (idx !== lastIdx && labels.current) {
          labels.current.querySelectorAll('.section-label').forEach((n, i) => n.classList.toggle('current', i === idx))
          lastIdx = idx
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [engine, song, version])

  if (!song) return <div className="timeline empty">No song loaded</div>

  const seekFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    engine.seek(((e.clientX - r.left) / r.width) * song.duration)
  }

  return (
    <div className="timeline">
      <div className="section-labels" ref={labels}>
        {song.sections.map((s, i) => {
          const left = (s.start / song.duration) * 100
          const width = ((sectionEnd(song, i) - s.start) / song.duration) * 100
          const looping = state.loop?.sectionId === s.id
          const pending = state.pendingJump?.sectionId === s.id
          return (
            <div
              key={s.id}
              className={`section-label ${looping ? 'looping' : ''} ${pending ? 'pending' : ''}`}
              style={{ left: `${left}%`, width: `${width}%`, ['--c' as string]: sectionColor(s.name) }}
            >
              <button
                className="section-jump"
                onClick={() => engine.jumpToSection(s.id, jumpMode)}
                title={`Jump to ${s.name}${i < 9 ? ` (${i + 1})` : ''}`}
              >
                {s.name}
              </button>
              <button
                className={`section-loop ${looping ? 'on' : ''}`}
                onClick={() => engine.toggleLoop(s.id)}
                title={looping ? 'Stop looping' : `Loop ${s.name}`}
                aria-pressed={looping}
              >
                ⟳
              </button>
            </div>
          )
        })}
      </div>
      <div
        className="wave"
        ref={wrap}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seekFromEvent(e)
        }}
      >
        <canvas ref={canvas} />
        {state.loop && (
          <div
            className="loop-region"
            style={{
              left: `${(state.loop.start / song.duration) * 100}%`,
              width: `${((state.loop.end - state.loop.start) / song.duration) * 100}%`,
            }}
          />
        )}
        <div className="playhead" ref={playhead} />
      </div>
    </div>
  )
}
