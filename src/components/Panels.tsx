import { useState } from 'react'
import type { Engine, EngineState, JumpMode } from '../audio/engine'
import type { PadPlayer } from '../audio/pad'
import { type Bus, KEYS, type Song, formatTime, sectionColor, uid } from '../audio/types'

export function BusesPanel({ engine, state }: { engine: Engine; state: EngineState }) {
  const buses: { id: Bus; label: string }[] = [
    { id: 'main', label: 'Main (L+R)' },
    { id: 'left', label: 'Left only' },
    { id: 'right', label: 'Right only' },
  ]
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Buses</h3>
        <p>
          Route channels to an output side. Typical in-ear setup: click &amp; guide hard left, tracks right, then
          split the two sides at the desk.
        </p>
        <button
          className="small"
          onClick={() => {
            for (const c of state.channels) {
              const toLeft = c.group === 'click' || c.name.toLowerCase().includes('guide')
              engine.setChannel(c.id, { bus: toLeft ? 'left' : 'right' })
            }
          }}
        >
          Click/Guide left · Tracks right
        </button>
        <button className="small" onClick={() => state.channels.forEach((c) => engine.setChannel(c.id, { bus: 'main' }))}>
          All to Main
        </button>
      </div>
      <div className="bus-grid">
        {state.channels
          .filter((c) => c.id !== 'accent' && c.id !== 'q' && c.id !== 'e' && c.id !== 's')
          .map((c) => (
            <label key={c.id} className="bus-row">
              <span>{c.name}</span>
              <select value={c.settings.bus} onChange={(e) => engine.setChannel(c.id, { bus: e.target.value as Bus })}>
                {buses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
      </div>
    </div>
  )
}

interface PadProps {
  pad: PadPlayer
  padOn: boolean
  setPadOn: (on: boolean) => void
  followSong: boolean
  setFollowSong: (v: boolean) => void
  padKey: string
  setPadKey: (k: string) => void
}

export function PadPanel({ pad, padOn, setPadOn, followSong, setFollowSong, padKey, setPadKey }: PadProps) {
  const [vol, setVol] = useState(pad.volume)
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Pad Player</h3>
        <p>Ambient pad that keeps playing between songs. Pick a key or let it follow the selected song.</p>
        <button className={`small ${padOn ? 'on' : ''}`} onClick={() => setPadOn(!padOn)}>
          {padOn ? 'Pad on' : 'Pad off'}
        </button>
        <label className="check">
          <input type="checkbox" checked={followSong} onChange={(e) => setFollowSong(e.target.checked)} /> Follow song key
        </label>
        <label className="range">
          Level
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
            onChange={(e) => {
              const v = Number(e.target.value)
              setVol(v)
              pad.setVolume(v)
            }}
          />
        </label>
      </div>
      <div className="key-grid">
        {KEYS.map((k) => (
          <button
            key={k}
            className={k === padKey ? 'on' : ''}
            onClick={() => {
              setFollowSong(false)
              setPadKey(k)
              if (!padOn) setPadOn(true)
            }}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  )
}

interface EditProps {
  engine: Engine
  song: Song
  onChange: () => void
}

const SECTION_NAMES = [
  'Count-in',
  'Intro',
  'Verse 1',
  'Verse 2',
  'Verse 3',
  'Pre-chorus',
  'Chorus 1',
  'Chorus 2',
  'Chorus 3',
  'Bridge',
  'Instrumental',
  'Turnaround',
  'Tag',
  'Outro',
  'Ending',
]

export function EditPanel({ engine, song, onChange }: EditProps) {
  const update = (patch: Partial<Song>, regenClick = false) => {
    Object.assign(song, patch)
    if (regenClick) engine.regenerateClick()
    onChange()
  }
  const sortSections = () => {
    song.sections.sort((a, b) => a.start - b.start)
    engine.sectionsChanged()
    onChange()
  }
  return (
    <div className="panel edit-panel">
      <div className="panel-head">
        <h3>Edit song</h3>
        <label>
          Title
          <input value={song.title} onChange={(e) => update({ title: e.target.value })} />
        </label>
        <div className="row">
          <label>
            Key
            <select value={song.key} onChange={(e) => update({ key: e.target.value })}>
              {KEYS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            BPM
            <input
              type="number"
              min={30}
              max={300}
              step={0.1}
              value={song.bpm}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v >= 30 && v <= 300) update({ bpm: v }, true)
              }}
            />
          </label>
          <label>
            Time sig
            <select
              value={song.timeSig.join('/')}
              onChange={(e) => update({ timeSig: e.target.value.split('/').map(Number) as [number, number] }, true)}
            >
              {['2/4', '3/4', '4/4', '5/4', '6/8', '12/8'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label title="Where bar 1 beat 1 falls in the audio, in seconds">
            Click offset
            <input
              type="number"
              min={0}
              step={0.001}
              value={song.clickOffset}
              onChange={(e) => update({ clickOffset: Math.max(0, Number(e.target.value)) }, true)}
            />
          </label>
        </div>
        <button
          className="small"
          onClick={() => {
            const at = engine.position
            if (song.sections.some((s) => Math.abs(s.start - at) < 0.05)) return
            song.sections.push({ id: uid('sec'), name: 'Verse 1', start: at })
            sortSections()
          }}
        >
          + Section at playhead
        </button>
      </div>
      <div className="section-list">
        {song.sections.map((s, i) => (
          <div key={s.id} className="section-row" style={{ ['--c' as string]: sectionColor(s.name) }}>
            <input
              list="section-names"
              value={s.name}
              onChange={(e) => {
                s.name = e.target.value
                onChange()
              }}
            />
            <input
              type="number"
              step={0.01}
              min={0}
              value={Math.round(s.start * 1000) / 1000}
              disabled={i === 0}
              onChange={(e) => {
                s.start = Math.max(0, Math.min(song.duration - 0.1, Number(e.target.value)))
                engine.sectionsChanged()
                onChange()
              }}
              onBlur={sortSections}
            />
            <span className="section-time">{formatTime(s.start)}</span>
            <button
              title="Move section start to playhead"
              disabled={i === 0}
              onClick={() => {
                s.start = engine.position
                sortSections()
              }}
            >
              ⇥
            </button>
            <button
              title="Delete section"
              disabled={song.sections.length === 1}
              onClick={() => {
                song.sections.splice(i, 1)
                song.sections[0].start = 0
                engine.sectionsChanged()
                onChange()
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <datalist id="section-names">
          {SECTION_NAMES.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </div>
    </div>
  )
}

interface MenuProps {
  jumpMode: JumpMode
  setJumpMode: (m: JumpMode) => void
  fadeSeconds: number
  setFadeSeconds: (s: number) => void
  onClose: () => void
}

export function Menu({ jumpMode, setJumpMode, fadeSeconds, setFadeSeconds, onClose }: MenuProps) {
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label>
          Section jumps
          <select value={jumpMode} onChange={(e) => setJumpMode(e.target.value as JumpMode)}>
            <option value="immediate">Immediately</option>
            <option value="bar">At the next bar</option>
            <option value="section">At the end of the section</option>
          </select>
        </label>
        <label>
          Fade-out length
          <select value={fadeSeconds} onChange={(e) => setFadeSeconds(Number(e.target.value))}>
            {[2, 4, 6, 8, 12].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </label>
        <h4>Keyboard</h4>
        <dl className="shortcuts">
          <dt>Space</dt>
          <dd>Play / pause</dd>
          <dt>←</dt>
          <dd>Back to start / previous song</dd>
          <dt>→</dt>
          <dd>Next song</dd>
          <dt>1–9</dt>
          <dd>Jump to section</dd>
          <dt>L</dt>
          <dd>Loop current section</dd>
          <dt>F</dt>
          <dd>Fade out</dd>
        </dl>
        <p className="hint">Drop audio files anywhere on the window to import them as a new song.</p>
        <button className="small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
