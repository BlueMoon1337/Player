/**
 * A section's Fade Out on the timeline, as Playback draws it: the fade as a slope down to silence
 * over the end of the section, a handle at its start showing how long it lasts (drag it to make
 * the fade longer or shorter), and the music after it dimmed, since the song stops there.
 */
import { useRef, useState } from 'react'
import { FADE_MAX, FADE_MIN, fadeOut, toHeard, toSong } from '../audio/arrangement'
import { nearestBar } from '../audio/grid'
import type { Song } from '../audio/types'
import { getSettings } from '../settings'

/** "-0:15.5": how long before the end the fade starts. */
export function fadeLabel(seconds: number) {
  const t = Math.max(0, seconds)
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `-${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function FadeOverlay({
  song,
  length,
  edit,
}: {
  song: Song
  /** The timeline's length, as heard. */
  length: number
  edit?: (label: string, change: () => void) => void
}) {
  const f = fadeOut(song)
  const [drag, setDrag] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  if (!f || length <= 0) return null
  const end = toHeard(song, f.end)
  const fade = drag ?? f.length
  const start = end - fade
  const pct = (t: number) => `${(t / length) * 100}%`

  /** The fade length for a pointer at clientX: from there to the fade's end (on a bar, with the grid on). */
  const lengthAt = (clientX: number) => {
    const wave = box.current?.parentElement
    if (!wave) return fade
    const r = wave.getBoundingClientRect()
    let heard = ((clientX - r.left) / r.width) * length
    if (getSettings().waveformGrid) heard = toHeard(song, nearestBar(song, toSong(song, heard)))
    return Math.max(FADE_MIN, Math.min(FADE_MAX, end, end - heard))
  }

  return (
    <div className="fade-overlay" ref={box}>
      {/* The slope: silence fills in above the line as the fade goes on. */}
      <svg className="fade-shape" style={{ left: pct(start), width: pct(fade) }} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 0 L0 30 L100 100 L100 0 Z" />
        <path className="fade-line" d="M0 30 L100 100" vectorEffect="non-scaling-stroke" />
      </svg>
      {end < length - 0.05 && (
        <div className="fade-after" style={{ left: pct(end), width: pct(length - end) }}>
          <span>After the fade</span>
        </div>
      )}
      <div className="fade-handle" style={{ left: pct(start) }}>
        <span className="fade-time">{fadeLabel(fade)}</span>
        <button
          className="fade-knob"
          title={edit ? `${f.section.name} fades out over ${fade.toFixed(1)} s. Drag to change it.` : `Fades out over ${fade.toFixed(1)} s`}
          aria-label="Fade out length"
          onPointerDown={(e) => {
            e.stopPropagation()
            if (!edit) return
            e.currentTarget.setPointerCapture(e.pointerId)
            setDrag(lengthAt(e.clientX))
          }}
          onPointerMove={(e) => {
            if (drag !== null) setDrag(lengthAt(e.clientX))
          }}
          onPointerUp={(e) => {
            if (drag === null) return
            const seconds = Math.round(lengthAt(e.clientX) * 10) / 10
            setDrag(null)
            if (edit && Math.abs(seconds - f.length) > 0.05) edit('Change Fade Out', () => (f.section.fadeOut = seconds))
          }}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={(e) => {
            // ← / → lengthen and shorten the fade by a second.
            if (!edit || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
            e.preventDefault()
            e.stopPropagation()
            const seconds = Math.max(FADE_MIN, Math.min(FADE_MAX, end, Math.round(f.length + (e.key === 'ArrowLeft' ? 1 : -1))))
            if (seconds !== f.length) edit('Change Fade Out', () => (f.section.fadeOut = seconds))
          }}
        />
      </div>
    </div>
  )
}
