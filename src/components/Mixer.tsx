import { useEffect, useRef, useState } from 'react'
import { type Engine, type EngineState, type GroupSettings, type LoopMode, faderToDb } from '../audio/engine'
import { beatAt } from '../audio/grid'
import { PAD_SOUNDS, type ImportedPad, type PadPlayer } from '../audio/pad'
import { type BusId, TRACK_BUSES, busName, defaultTrackBus } from '../audio/routing'
import { type Bus, type ChannelSettings, type Song, busLabel, busOptions, sectionIndexAt } from '../audio/types'
import { type MenuEntry, confirmDialog, showContextMenu } from './Ask'
import { busSettingsLocked } from './RoutingTabs'
import { getSettings, setSetting, useSettings } from '../settings'
import { Fader } from './Fader'
import { LoopForeverIcon, LoopOnceIcon } from './LoopIcons'
import { ConsoleButton, consoleMenu, useConsoleState } from './ConsoleButton'

export type LowerView = 'mixer' | 'buses' | 'pad'

interface Props {
  engine: Engine
  state: EngineState
  song: Song | null
  view: LowerView
  setView: (v: LowerView) => void
  pad: PadPlayer
  padOn: boolean
  setPadOn: (on: boolean) => void
  padKey: string
  /** Picks a key by hand and starts the pad; the next song chosen brings its own key (Follow Song Key). */
  playPadKey: (k: string) => void
  /** Pad On When a Song Starts (in the sound menu): on, in the song's key, as each song starts. */
  autoPad: boolean
  setAutoPad: (v: boolean) => void
  /** The pad follows the loaded song's key (in the sound menu). */
  padFollow: boolean
  setPadFollow: (v: boolean) => void
  /** The Default Ambient Pad: a built-in sound's id, or an imported pad's. */
  padSound: string
  /** The loaded song's own pad (Song Settings), which plays instead of the default. */
  songPad?: string
  setPadSound: (id: string) => void
  importedPads: ImportedPad[]
  /** IMPORT: pads from zips of WAV files. */
  onImportPads: () => void
  /** Desktop: deletes an imported pad (asking first). */
  onDeletePad?: (pad: ImportedPad) => void
  /** Opens Settings at Tracks (a track's bus) or Buses (a bus's output). */
  onRouting: (tab: 'tracks' | 'buses') => void
}

/** Playback's key layout: the flats above, the naturals below. */
const PAD_ROWS = [
  ['Db', 'Eb', 'Gb', 'Ab', 'Bb', 'B'],
  ['C', 'D', 'E', 'F', 'G', 'A'],
]

type Meter = () => number

/** Drives every meter on screen from one animation loop: fast attack, slow release. */
/**
 * A click channel's meter: its level, or with Metronome Style VU, a flash on its beats (the
 * accent on the downbeat, 1/4 on the other beats, 1/8 and 1/16 on theirs, the click on every beat).
 */
function clickMeter(engine: Engine, id: string): number {
  if (!getSettings().metronomeVU) return engine.meter(id)
  const song = engine.currentSong
  if (!song || !engine.isPlaying) return 0
  // The beat playing now, through tempo and time signature changes, and where in it.
  const b = beatAt(song, engine.position)
  if (!b) return 0
  const per = id === 'e' ? 2 : id === 's' ? 4 : 1
  const rel = ((engine.position - b.time) / b.length) * per
  const n = Math.floor(rel + 1e-6)
  const since = ((rel - n) * b.length) / per
  const onBeat = n === 0
  if (id === 'accent' && !(onBeat && b.index === 0)) return 0
  if (id === 'q' && !(onBeat && b.index !== 0)) return 0
  if ((id === 'e' || id === 's') && onBeat) return 0
  return Math.exp(-since * 14)
}

function useMeters() {
  const els = useRef(new Map<HTMLDivElement, Meter>())
  useEffect(() => {
    let raf = 0
    const levels = new WeakMap<HTMLDivElement, number>()
    const loop = () => {
      // Power Saver: no meters.
      const off = getSettings().powerSaver
      for (const [el, read] of els.current) {
        const peak = off ? 0 : Math.min(1, read())
        const prev = levels.get(el) ?? 0
        const lvl = peak > prev ? peak : prev * 0.9
        levels.set(el, lvl)
        el.style.height = `${Math.sqrt(lvl) * 100}%`
        el.classList.toggle('hot', lvl > 0.95)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (read: Meter) => (el: HTMLDivElement | null) => {
    // Each render hands over a fresh callback; drop entries whose element is gone.
    for (const k of els.current.keys()) if (!k.isConnected) els.current.delete(k)
    if (el) els.current.set(el, read)
  }
}

interface StripProps {
  id: string
  name: string
  className?: string
  volume: number
  mute: boolean
  solo?: boolean
  onVolume: (v: number) => void
  onMute: () => void
  onSolo?: () => void
  meter: (el: HTMLDivElement | null) => void
  /** A small route tag under the name when it doesn't go to Main. */
  route?: string
  /** Buses and the master have a cyan line on the fader cap, as in Playback. */
  cyan?: boolean
  /** The ‹ › beside the strip: shows or hides the channels behind it. */
  expand?: { open: boolean; toggle: () => void; label: string }
  menu?: () => MenuEntry[]
  nameExtra?: JSX.Element
}

/** One channel strip: S at the top, a meter beside the fader, and the name (tap it to mute). */
function Strip(p: StripProps) {
  return (
    <div
      className={`strip ${p.className ?? ''} ${p.mute ? 'muted' : ''} ${p.cyan ? 'cyan' : ''}`}
      onContextMenu={p.menu ? (e) => showContextMenu(e, p.menu!()) : undefined}
      title={`${p.name}: ${faderToDb(p.volume)} dB`}
    >
      {p.onSolo ? (
        <button className={`btn-solo ${p.solo ? 'on' : ''}`} onClick={p.onSolo} title="Solo" aria-pressed={p.solo}>
          S
        </button>
      ) : (
        <span className="btn-solo placeholder" />
      )}
      <Fader label={`${p.name} volume`} value={p.volume} onChange={p.onVolume} meterRef={p.meter} />
      <button className="strip-name" onClick={p.onMute} title={p.mute ? `Unmute ${p.name}` : `Mute ${p.name}`} aria-pressed={p.mute}>
        <span>{p.name}</span>
        {p.nameExtra}
        {p.route && <span className="strip-bus">{p.route}</span>}
      </button>
      {p.expand && (
        <button
          className={`strip-expand ${p.expand.open ? 'open' : ''}`}
          onClick={p.expand.toggle}
          title={p.expand.open ? `Hide ${p.expand.label}` : `Show ${p.expand.label}`}
          aria-expanded={p.expand.open}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={p.expand.open ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
          </svg>
        </button>
      )}
    </div>
  )
}

const shortRoute = (bus: Bus) => (bus === 'main' ? undefined : busLabel(bus).replace(/^Out | \(mono\)$/g, ''))

export function Mixer(p: Props) {
  const { engine, state, song, view, setView, pad } = p
  const settings = useSettings()
  const consoleState = useConsoleState()
  const meter = useMeters()
  const [clickOpen, setClickOpen] = useState(false)
  const [openBuses, setOpenBuses] = useState<Set<string>>(new Set())
  const [padVolume, setPadVolume] = useState(pad.volume)

  // Under Auto Pan the click and guide go out the left, everything else the right.
  const routeTag = (output: Bus | null) =>
    !output ? undefined : state.autoPan ? (output === 'mono:0' ? 'L' : 'R') : shortRoute(output)

  /** A bus's output (Settings ▸ Buses). */
  const outputMenu = (id: BusId, current: Bus | null): MenuEntry[] => [
    state.autoPan
      ? { label: 'Output', onClick: () => void busSettingsLocked() }
      : {
          label: 'Output',
          submenu: busOptions(state.outputCount).map((b) => ({
            label: `${b === current ? '✓ ' : ''}${busLabel(b)}`,
            onClick: () => setSetting('busOutputs', { ...getSettings().busOutputs, [id]: b }),
          })),
        },
    { label: 'Buses…', onClick: () => p.onRouting('buses') },
  ]

  /** The bus a track goes to (Settings ▸ Tracks): for this track name in every song. */
  const trackMenu = (name: string, current: BusId | null): MenuEntry[] => [
    {
      label: 'Bus',
      submenu: TRACK_BUSES.map((b) => ({
        label: `${b.id === current ? '✓ ' : ''}${busName(b.id, settings.busNames)}`,
        onClick: () => {
          const { [name]: _, ...rest } = getSettings().trackBuses
          setSetting('trackBuses', b.id === defaultTrackBus(name) ? rest : { ...rest, [name]: b.id })
        },
      })),
    },
    { label: 'Tracks…', onClick: () => p.onRouting('tracks') },
  ]

  const channelStrip = (c: EngineState['channels'][number], className = '', extra: Partial<StripProps> = {}) => {
    const set = (patch: Partial<ChannelSettings>) => engine.setChannel(c.id, patch)
    const s = c.settings
    // A muted bus shows its tracks muted too.
    const busMuted =
      c.busGroup === 'click'
        ? !!state.channels.find((x) => x.id === 'click')?.settings.mute
        : !!c.busGroup && !!state.groups.find((g) => g.id === c.busGroup)?.settings.mute
    return (
      <Strip
        key={c.id}
        id={c.id}
        name={c.name}
        className={`${c.group} ${className} ${busMuted ? 'bus-muted' : ''}`}
        volume={s.volume}
        mute={s.mute}
        solo={s.solo}
        onVolume={(v) => set({ volume: v })}
        onMute={() => set({ mute: !s.mute })}
        onSolo={() => set({ solo: !s.solo })}
        meter={meter(c.group === 'click' && c.id !== 'cues' ? () => clickMeter(engine, c.id) : () => engine.meter(c.id))}
        route={routeTag(c.output)}
        menu={() => [
          { label: s.mute ? 'Unmute' : 'Mute', onClick: () => set({ mute: !s.mute }) },
          { label: s.solo ? 'Unsolo' : 'Solo', onClick: () => set({ solo: !s.solo }) },
          { label: 'Reset Volume', onClick: () => set({ volume: 0.75 }) },
          ...(c.group === 'stem' ? (['separator', ...trackMenu(c.name, c.busGroup)] as MenuEntry[]) : []),
          ...(c.id === 'click' ? (['separator', ...outputMenu('click', c.output)] as MenuEntry[]) : []),
        ]}
        {...extra}
      />
    )
  }

  // A song playing its own click stem shows that instead of the generated click's parts.
  const generated = new Set(['accent', 'q', 'e', 's'])
  const clickBus = state.channels.find((c) => c.id === 'click')
  // The Cues strip shows while there are spoken cues; a reference track only with Reference Track on.
  const clickParts = state.channels.filter(
    (c) => c.group === 'click' && c.id !== 'click' && !(state.audioClick && generated.has(c.id)) && (c.id !== 'cues' || state.cues),
  )
  // With Auto Pan on, the tracks that go to the in-ears (the guide) sit next to the click.
  const inEar = (c: EngineState['channels'][number]) => state.autoPan && c.output === 'mono:0'
  const stems = state.channels
    .filter((c) => c.group === 'stem' && (settings.referenceTrack || !c.reference))
    .sort((a, b) => Number(inEar(b)) - Number(inEar(a)))
  const empty = <div className="empty">{engine.currentSong ? 'Loading stems…' : 'No song loaded'}</div>

  const clickStrip = clickBus && (
    <div className={`strip-group click-group ${clickOpen ? 'open' : ''}`}>
      {channelStrip(clickBus, '', {
        expand: { open: clickOpen, toggle: () => setClickOpen(!clickOpen), label: 'the click parts' },
      })}
      {clickOpen && <div className="strip-sub">{clickParts.map((c) => channelStrip(c, 'sub'))}</div>}
    </div>
  )

  let main: JSX.Element
  if (view === 'pad') {
    // The card shows what plays: the song's own pad if it has one, else the default.
    const playing = p.songPad ?? p.padSound
    const builtIn = PAD_SOUNDS.find((s) => s.id === playing)
    const imported = p.importedPads.find((x) => x.id === playing)
    const sound = imported
      ? {
          name: imported.name,
          by: `Imported · ${new Set(imported.files.map((f) => f.key ?? 'C')).size} of 12 keys`,
          hue: [...imported.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7),
        }
      : { name: (builtIn ?? PAD_SOUNDS[0]).name, by: 'Player', hue: (builtIn ?? PAD_SOUNDS[0]).hue }
    if (p.songPad) sound.by = `This song’s pad (Song Settings) · ${sound.by}`
    const soundMenu = (): MenuEntry[] => {
      const item = (id: string, name: string): MenuEntry => ({
        label: `${id === p.padSound ? '✓ ' : ''}${name}`,
        onClick: () => p.setPadSound(id),
      })
      const entries: MenuEntry[] = PAD_SOUNDS.map((s) => item(s.id, s.name))
      if (p.importedPads.length) entries.push('separator', ...p.importedPads.map((x) => item(x.id, x.name)))
      entries.push(
        'separator',
        { label: `${p.autoPad ? '✓ ' : ''}Pad On When a Song Starts`, onClick: () => p.setAutoPad(!p.autoPad) },
        { label: `${p.padFollow ? '✓ ' : ''}Follow Song Key`, onClick: () => p.setPadFollow(!p.padFollow) },
        { label: 'Import Pads…', onClick: p.onImportPads },
      )
      if (imported && p.onDeletePad) entries.push({ label: `Delete “${imported.name}”…`, danger: true, onClick: () => p.onDeletePad!(imported) })
      return entries
    }
    main = (
      <div className="mixer-strips pad-view">
        <div className="strip-group">
          <Strip
            id="pad"
            name="Pad"
            className="pad"
            volume={padVolume}
            mute={false}
            onVolume={(v) => {
              setPadVolume(v)
              pad.setVolume(v)
            }}
            onMute={() => p.setPadOn(!p.padOn)}
            meter={meter(() => pad.meter())}
            nameExtra={
              <svg className={`pad-play ${p.padOn ? 'on' : ''}`} viewBox="0 0 24 24" aria-label={p.padOn ? 'Pad on' : 'Pad off'}>
                <path d="M8 5v14l11-7z" />
              </svg>
            }
          />
        </div>
        <div className="pad-main">
          <div className="pad-top">
            <button
              className="pad-sound"
              title="Choose the pad sound"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                showContextMenu({ clientX: r.right - 240, clientY: r.bottom + 4, preventDefault() {} }, soundMenu())
              }}
            >
              <span className="pad-art" style={{ ['--h' as string]: sound.hue }} />
              <span className="pad-sound-text">
                <b>{sound.name}</b>
                <span>
                  {sound.by}
                  {p.autoPad ? ' · on with each song' : p.padFollow ? ' · follows the song’s key' : ''}
                </span>
              </span>
              <svg className="pad-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button className="pad-import" onClick={p.onImportPads} title="Import pads: zips of WAV files, one per key">
              IMPORT
            </button>
          </div>
          <div className="pad-keys">
            {PAD_ROWS.flat().map((k) => {
              const active = p.padOn && k === p.padKey
              return (
                <button
                  key={k}
                  className={`pad-key ${active ? 'active' : ''} ${k === p.padKey ? 'current' : ''}`}
                  onClick={() => (active ? p.setPadOn(false) : p.playPadKey(k))}
                  title={active ? `Stop the pad` : `Play the pad in ${k}`}
                >
                  {k}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  } else if (view === 'buses') {
    const setGroup = (id: BusId, patch: Partial<GroupSettings>) => engine.setGroup(id, patch)
    const onClickBus = stems.filter((c) => c.busGroup === 'click')
    main = (
      <div className="mixer-strips buses-view">
        {clickBus && (
          // The Click bus: the click, and any track routed to it (a reference, say), behind its ›.
          <div className={`strip-group click-group ${onClickBus.length && openBuses.has('click') ? 'open' : ''}`}>
            {channelStrip(
              clickBus,
              'bus',
              onClickBus.length
                ? {
                    expand: {
                      open: openBuses.has('click'),
                      label: onClickBus.length === 1 ? 'its track' : `its ${onClickBus.length} tracks`,
                      toggle: () => {
                        const next = new Set(openBuses)
                        if (!next.delete('click')) next.add('click')
                        setOpenBuses(next)
                      },
                    },
                  }
                : {},
            )}
            {onClickBus.length > 0 && openBuses.has('click') && (
              <div className="strip-sub">{onClickBus.map((c) => channelStrip(c, 'sub'))}</div>
            )}
          </div>
        )}
        {state.groups.length ? (
          <div className="strip-group stem-group">
            {state.groups.map((g) => {
              const open = openBuses.has(g.id)
              const name = busName(g.id, settings.busNames, true)
              const members = g.members
                .map((id) => state.channels.find((c) => c.id === id)!)
                .filter((c) => c && (settings.referenceTrack || !c.reference))
              return (
                <div key={g.id} className={`bus-wrap ${open ? 'open' : ''}`}>
                  <Strip
                    id={`bus:${g.id}`}
                    name={name}
                    className="stem bus"
                    cyan
                    volume={g.settings.volume}
                    mute={g.settings.mute}
                    solo={g.settings.solo}
                    onVolume={(v) => setGroup(g.id, { volume: v })}
                    onMute={() => setGroup(g.id, { mute: !g.settings.mute })}
                    onSolo={() => setGroup(g.id, { solo: !g.settings.solo })}
                    meter={meter(() => engine.groupMeter(g.id))}
                    route={routeTag(g.output)}
                    expand={{
                      open,
                      label: members.length === 1 ? 'its track' : `its ${members.length} tracks`,
                      toggle: () => {
                        const next = new Set(openBuses)
                        if (open) next.delete(g.id)
                        else next.add(g.id)
                        setOpenBuses(next)
                      },
                    }}
                    menu={() => [
                      { label: g.settings.mute ? 'Unmute' : 'Mute', onClick: () => setGroup(g.id, { mute: !g.settings.mute }) },
                      { label: g.settings.solo ? 'Unsolo' : 'Solo', onClick: () => setGroup(g.id, { solo: !g.settings.solo }) },
                      { label: 'Reset Volume', onClick: () => setGroup(g.id, { volume: 0.75 }) },
                      'separator',
                      ...outputMenu(g.id, g.output),
                    ]}
                  />
                  {open && <div className="strip-sub">{members.map((c) => channelStrip(c, 'sub'))}</div>}
                </div>
              )
            })}
          </div>
        ) : (
          empty
        )}
      </div>
    )
  } else {
    main = (
      <div className="mixer-strips">
        {clickStrip}
        <div className="strip-group stem-group">{stems.length ? stems.map((c) => channelStrip(c)) : empty}</div>
      </div>
    )
  }

  // The loop buttons light while that kind of loop is on, and act on the section under the playhead.
  const loopButton = (mode: LoopMode, label: string, icon: JSX.Element) => {
    const on = state.loop?.mode === mode
    return (
      <button
        className={`side-icon ${on ? 'on' : ''}`}
        disabled={!song?.sections.length}
        onClick={() => {
          if (!song?.sections.length) return
          if (on) engine.setLoop(null)
          else engine.setLoop(song.sections[sectionIndexAt(song, engine.position)].id, mode)
        }}
        title={`${label} (${mode === 'forever' ? 'L' : '⇧L'})`}
        aria-pressed={on}
      >
        {icon}
      </button>
    )
  }

  return (
    <div className={`mixer view-${view}`}>
      {main}
      <div className="mixer-side">
        <button className={`side-icon ${view === 'mixer' ? 'on' : ''}`} onClick={() => setView('mixer')} title="Mixer" aria-pressed={view === 'mixer'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 4v16M12 4v16M18 4v16" />
            <path className="knob" d="M3.5 14h5M9.5 8h5M15.5 12h5" />
          </svg>
        </button>
        <button className={view === 'buses' ? 'on' : ''} onClick={() => setView(view === 'buses' ? 'mixer' : 'buses')} aria-pressed={view === 'buses'}>
          Buses
        </button>
        <button
          className={`${view === 'pad' ? 'on' : ''} ${p.padOn ? 'lit' : ''}`}
          onClick={() => setView(view === 'pad' ? 'mixer' : 'pad')}
          aria-pressed={view === 'pad'}
        >
          Pad Player
        </button>
        <button
          className={engine.midiMuted ? 'warn' : ''}
          onClick={() => engine.setMidiMuted(!engine.midiMuted)}
          disabled={!state.midiOut}
          title={
            !state.midiOut
              ? 'MIDI Out is off in Settings'
              : engine.midiAvailable
                ? 'Stop sending MIDI start/stop/program changes'
                : 'No MIDI outputs detected'
          }
          aria-pressed={engine.midiMuted}
        >
          Mute MIDI
        </button>
        {loopButton('once', 'Repeat this section once', <LoopOnceIcon />)}
        {loopButton('forever', 'Repeat this section until turned off', <LoopForeverIcon />)}
      </div>
      <div
        className={`strip master ${consoleState?.button ? 'has-console' : ''}`}
        // Right-click the Master strip to set up the console button (desktop only).
        onContextMenu={consoleState ? (e) => showContextMenu(e, consoleMenu(consoleState)) : undefined}
      >
        {view === 'pad' ? (
          <span className="btn-solo placeholder" />
        ) : (
          <button
            className="btn-solo btn-reset"
            title={view === 'buses' ? 'Reset the buses to their default level, for this song' : 'Reset the tracks to their default level, for this song'}
            aria-label={view === 'buses' ? 'Reset bus volumes' : 'Reset track volumes'}
            onClick={async () => {
              const which = view === 'buses' ? 'buses' : 'tracks'
              const ok = await confirmDialog({
                title: which === 'buses' ? 'Reset the bus volumes?' : 'Reset the track volumes?',
                message: `Every ${which === 'buses' ? 'bus' : 'track'} fader${song ? ` in “${song.title}”` : ''} goes back to its default level. Mutes stay as they are.`,
                confirmLabel: 'Reset',
              })
              if (ok) engine.resetVolumes(which)
            }}
          >
            ↺
          </button>
        )}
        <ConsoleButton />
        <div className="master-fader">
          <div className="master-meters">
            <div className="master-meter">
              <div className="fader-meter" ref={meter(() => engine.masterMeter()[0])} />
            </div>
            <div className="master-meter">
              <div className="fader-meter" ref={meter(() => engine.masterMeter()[1])} />
            </div>
          </div>
          <Fader label="Master volume" value={state.masterVolume} onChange={(v) => engine.setMasterVolume(v)} />
        </div>
        <div className="strip-name static">Master</div>
      </div>
    </div>
  )
}
