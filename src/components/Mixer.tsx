import { useEffect, useRef } from 'react'
import { type Engine, type EngineState, faderToDb } from '../audio/engine'
import { type ChannelSettings, busLabel } from '../audio/types'
import { Fader } from './Fader'

interface Props {
  engine: Engine
  state: EngineState
  panel: 'buses' | 'pad' | null
  setPanel: (p: 'buses' | 'pad' | null) => void
  link: boolean
  setLink: (v: boolean) => void
  padOn: boolean
}

export function Mixer({ engine, state, panel, setPanel, link, setLink, padOn }: Props) {
  const meters = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    let raf = 0
    const levels = new Map<string, number>()
    const loop = () => {
      for (const [id, el] of meters.current) {
        const peak = Math.min(1, engine.meter(id))
        // Fast attack, slow release.
        const prev = levels.get(id) ?? 0
        const lvl = peak > prev ? peak : prev * 0.9
        levels.set(id, lvl)
        el.style.height = `${Math.sqrt(lvl) * 100}%`
        el.classList.toggle('hot', lvl > 0.95)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  const strip = (c: EngineState['channels'][number]) => {
    const set = (patch: Partial<ChannelSettings>) => engine.setChannel(c.id, patch)
    const s = c.settings
    return (
      <div key={c.id} className={`strip ${c.group} ${s.mute ? 'muted' : ''}`}>
        <div className="strip-db">{faderToDb(s.volume)}</div>
        <Fader
          label={`${c.name} volume`}
          value={s.volume}
          onChange={(v) => set({ volume: v })}
          meterRef={(el) => {
            if (el) meters.current.set(c.id, el)
            else meters.current.delete(c.id)
          }}
        />
        <div className="strip-buttons">
          <button
            className={`btn-mute ${s.mute ? 'on' : ''}`}
            onClick={() => set({ mute: !s.mute })}
            title="Mute"
          >
            M
          </button>
          {c.group === 'stem' && (
            <button
              className={`btn-solo ${s.solo ? 'on' : ''}`}
              onClick={() => set({ solo: !s.solo })}
              title="Solo"
            >
              S
            </button>
          )}
        </div>
        <div className="strip-name" title={c.name}>
          {c.name}
          {s.bus !== 'main' && (
            <span className="strip-bus" title={busLabel(s.bus)}>
              {busLabel(s.bus).replace(/^Out | \(mono\)$/g, '')}
            </span>
          )}
        </div>
      </div>
    )
  }

  const clicks = state.channels.filter((c) => c.group === 'click')
  const stems = state.channels.filter((c) => c.group === 'stem')

  return (
    <div className="mixer">
      <div className="mixer-strips">
        <div className="strip-group click-group">{clicks.map(strip)}</div>
        <div className="strip-group stem-group">
          {stems.length ? stems.map(strip) : <div className="empty">Loading stems…</div>}
        </div>
        <div className="strip-group master-group">
          <div className="strip master">
            <div className="strip-db">{faderToDb(state.masterVolume)}</div>
            <Fader label="Master volume" value={state.masterVolume} onChange={(v) => engine.setMasterVolume(v)} />
            <div className="strip-buttons" />
            <div className="strip-name">Master</div>
          </div>
        </div>
      </div>
      <div className="mixer-side">
        <button className={panel === 'buses' ? 'on' : ''} onClick={() => setPanel(panel === 'buses' ? null : 'buses')}>
          Buses
        </button>
        <button
          className={`${panel === 'pad' ? 'on' : ''} ${padOn ? 'lit' : ''}`}
          onClick={() => setPanel(panel === 'pad' ? null : 'pad')}
        >
          Pad Player
        </button>
        <button
          className={engine.midiMuted ? 'on warn' : ''}
          onClick={() => engine.setMidiMuted(!engine.midiMuted)}
          title={engine.midiAvailable ? 'Stop sending MIDI start/stop/program changes' : 'No MIDI outputs detected'}
        >
          Mute MIDI
        </button>
        <button className={link ? 'on' : ''} onClick={() => setLink(!link)} title="Continue into the next song when a song ends">
          ⟲ Link
        </button>
      </div>
    </div>
  )
}
