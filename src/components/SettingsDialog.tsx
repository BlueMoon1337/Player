import { type ReactNode, useEffect, useState } from 'react'
import type { Engine, EngineState, JumpMode } from '../audio/engine'
import { desktop } from '../platform'
import type { ConsoleTarget, ExportFormat } from '../platform/types'
import { type ClickSound, type CueLanguage, setSetting, useSettings } from '../settings'
import { useAudioDevices } from './Panels'
import { BusesTab, TracksTab } from './RoutingTabs'
import { confirmDialog } from './Ask'
import { modelName, pickConsoleStrip, targetLabel, useConsoleState } from './ConsoleButton'

export type SettingsTab = 'general' | 'tracks' | 'buses' | 'console' | 'about'

interface Props {
  tab: SettingsTab
  setTab: (t: SettingsTab) => void
  engine: Engine
  state: EngineState
  /** The pads to choose the Default Ambient Pad from, and the chosen one. */
  pads: { id: string; name: string }[]
  defaultPad: string
  setDefaultPad: (id: string) => void
  /** Start Pad Player with Songs. */
  autoPad: boolean
  setAutoPad: (v: boolean) => void
  link: boolean
  setLink: (v: boolean) => void
  jumpMode: JumpMode
  setJumpMode: (m: JumpMode) => void
  fadeSeconds: number
  setFadeSeconds: (s: number) => void
  libraryRoot?: string | null
  onRevealLibrary?: () => void
  /** Desktop only: this version, whether a newer one is ready, and opening the Update window. */
  update?: { version: string | null; ready: string | null; onOpen: () => void }
  /** Desktop only: Export Player, in the formats this copy can be exported as (none in a development build). */
  exportPlayer?: { formats: ExportFormat[]; busy: boolean; run: (format: ExportFormat) => void }
  onClose: () => void
}

const EXPORT_LABELS: Record<ExportFormat, string> = { dmg: 'Disk Image…', zip: 'Zip…', appimage: 'AppImage…' }

const CLICK_SOUNDS: [ClickSound, string][] = [
  ['classic', 'Classic'],
  ['woodblock', 'Woodblock'],
  ['hihat', 'Hi-Hat'],
  ['beep', 'Beep'],
]

const CUE_LANGUAGES: [CueLanguage, string][] = [
  ['off', 'Off (the song’s Guide track)'],
  ['en-female', 'English - Female'],
  ['en-male', 'English - Male'],
  ['es', 'Spanish'],
  ['pt', 'Portuguese'],
  ['fr', 'French'],
]

/** One setting: its name and what it does on the left, its switch or choice on the right. */
function Row({ title, desc, children, disabled }: { title: string; desc: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`set-row ${disabled ? 'disabled' : ''}`}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        <div className="set-desc">{desc}</div>
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Switch({ on, set, label, disabled }: { on: boolean; set: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch set-switch"
      aria-label={label}
      checked={on}
      disabled={disabled}
      onChange={(e) => set(e.target.checked)}
    />
  )
}

/** A choice that reads as its value, as in Playback, with the menu underneath. */
function Choice<T extends string | number>({
  value,
  options,
  set,
  label,
  disabled,
}: {
  value: T
  options: [T, string][]
  set: (v: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <select
      className="set-choice"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => set((typeof value === 'number' ? Number(e.target.value) : e.target.value) as T)}
    >
      {options.map(([v, name]) => (
        <option key={String(v)} value={v}>
          {name}
        </option>
      ))}
    </select>
  )
}

function AudioDeviceChoice({ engine, state }: { engine: Engine; state: EngineState }) {
  const { devices } = useAudioDevices()
  const [error, setError] = useState<string | null>(null)
  if (!engine.canSelectOutput) return <span className="set-value">System default</span>
  return (
    <>
      <select
        className="set-choice"
        aria-label="Audio Device"
        value={state.outputDeviceId}
        onChange={(e) => {
          setError(null)
          engine.setOutputDevice(e.target.value, e.target.selectedOptions[0]?.textContent ?? '').catch((err: Error) => setError(err.message))
        }}
      >
        <option value="">System default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || 'Audio device'}
          </option>
        ))}
      </select>
      {error && <div className="set-error">{error}</div>}
    </>
  )
}

/** When a console was last on the network, in words. */
function seenAgo(at: number) {
  if (!at) return 'not seen yet'
  const min = Math.round((Date.now() - at) / 60_000)
  if (min < 1) return 'seen just now'
  if (min < 60) return `seen ${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `seen ${h} hour${h === 1 ? '' : 's'} ago`
  return `seen ${new Date(at).toLocaleDateString()}`
}

/**
 * Settings ▸ Console: the console button above the Master fader (what it mutes, on which console,
 * and whether it's there now) and the consoles Player remembers. The same as right-clicking the
 * button or the Master strip, laid out.
 */
function ConsoleTab() {
  const s = useConsoleState()
  const [error, setError] = useState<string | null>(null)
  if (!s) return null
  const b = s.button
  const online = (name: string) => s.online.includes(name)
  const run = (f: () => Promise<unknown>) => {
    setError(null)
    f().catch((e: Error) => setError(e.message))
  }
  const setUp = (name: string | null, current: ConsoleTarget | null) =>
    run(async () => {
      const picked = await pickConsoleStrip(name, current)
      if (picked) await desktop!.console.link(picked.name, picked.target)
    })
  const buttonName = b ? b.label || targetLabel(b.target) : ''
  const known = b ? s.consoles.find((c) => c.name === b.console) : undefined
  const state = !b
    ? null
    : !b.online
      ? s.blocked
        ? 'macOS is blocking Player from the local network: allow Player in System Settings ▸ Privacy & Security ▸ Local Network.'
        : `${b.console} isn’t on the network now, so the button is greyed out. It comes back when the console does.`
      : b.muted === null
        ? `Asking ${b.console}…`
        : `It’s ${b.muted ? 'muted' : 'on'} at the console now.`
  return (
    <div className="set-columns">
      <div className="set-col">
        <Row
          title="Console Button"
          desc={
            b ? (
              <>
                Mutes and unmutes <b>{buttonName}</b>
                {b.label ? ` (${targetLabel(b.target)})` : ''} on {modelName(known?.model ?? '')} “{b.console}”. {state}
              </>
            ) : (
              'A button above the Master fader that mutes and unmutes a channel, mix bus or DCA group on a Behringer or Midas X32 on this network. Until it’s set up, Player doesn’t look for consoles.'
            )
          }
        >
          {b ? (
            <div className="set-buttons console-buttons">
              <span className={`console-state ${!b.online ? 'offline' : b.muted ? 'muted' : b.muted === false ? 'on' : ''}`} aria-hidden="true" />
              <button className="small" disabled={!b.online} title={b.online ? undefined : 'The console has to be on the network'} onClick={() => setUp(b.console, b.target)}>
                Change…
              </button>
              <button className="small" onClick={() => run(() => desktop!.console.link(b.console, null))}>
                Remove
              </button>
            </div>
          ) : (
            <button className="small primary" onClick={() => setUp(s.online[0] ?? null, null)}>
              Set Up…
            </button>
          )}
        </Row>
        {error && <p className="console-error-line">{error}</p>}
        <Row
          title="Network"
          desc={
            s.blocked
              ? 'macOS is blocking Player from the local network. Allow Player in System Settings ▸ Privacy & Security ▸ Local Network, then quit and reopen Player.'
              : b
                ? 'Player looks for the button’s console every few seconds, by its name, so a new IP address doesn’t matter.'
                : s.searching
                  ? 'Looking for consoles…'
                  : 'Player isn’t looking for consoles: it sends nothing on the network until a button is set up.'
          }
        >
          <span className="set-value">{s.online.length ? `${s.online.length} console${s.online.length === 1 ? '' : 's'} found` : s.blocked ? 'Blocked' : '—'}</span>
        </Row>
      </div>
      <div className="set-col">
        <div className="set-section-title">Remembered Consoles</div>
        {s.consoles.length === 0 ? (
          <p className="console-empty">None yet. A console is remembered once the button is set up on it.</p>
        ) : (
          s.consoles.map((c) => (
            <Row
              key={c.name}
              title={c.name}
              desc={
                <>
                  {modelName(c.model)} at {c.address} · {online(c.name) ? 'on the network' : seenAgo(c.lastSeen)}
                  <br />
                  {c.target ? `Button: ${b?.console === c.name && b.label ? `${b.label} (${targetLabel(c.target)})` : targetLabel(c.target)}` : 'No button'}
                </>
              }
            >
              <div className="set-buttons console-buttons">
                <button
                  className="small"
                  disabled={!online(c.name)}
                  title={online(c.name) ? `Choose what the button mutes on ${c.name}` : 'The console has to be on the network'}
                  onClick={() => setUp(c.name, c.target)}
                >
                  {c.target ? 'Change…' : 'Use for Button…'}
                </button>
                <button
                  className="small destructive"
                  onClick={() =>
                    run(async () => {
                      const ok = await confirmDialog({
                        title: `Forget “${c.name}”?`,
                        message: 'Player stops remembering this console and what its button was set to.',
                        confirmLabel: 'Forget',
                        danger: true,
                      })
                      if (ok) await desktop!.console.forget(c.name)
                    })
                  }
                >
                  Forget…
                </button>
              </div>
            </Row>
          ))
        )}
      </div>
    </div>
  )
}

/** Settings, laid out like Playback's: General, Tracks, Buses, Console and About. */
export function SettingsDialog(p: Props) {
  const s = useSettings()
  const { tab, setTab } = p

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.ask-backdrop')) return
      e.stopPropagation()
      p.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [p])

  const cuesOff = s.cueLanguage === 'off'
  const general = (
    <div className="set-columns">
      <div className="set-col">
        <Row
          title="Auto Pan"
          desc="Send Click & Guide to output 1 (left) and tracks to output 2 (right). Turn it off to route buses in the Buses tab"
        >
          <Switch label="Auto Pan" on={s.autoPan} set={(v) => setSetting('autoPan', v)} />
        </Row>
        <Row title="Click Sound" desc="Choose a click sound. A song’s own Click Track is chosen in Song Settings ▸ Click.">
          <Choice label="Click Sound" value={s.clickSound} options={CLICK_SOUNDS} set={(v) => setSetting('clickSound', v)} />
        </Row>
        <Row
          title="Count Into Each Section"
          desc={cuesOff ? 'Adds a spoken count into each song section (turn on Guide Cue Language first)' : 'Adds a spoken count into each song section: “Chorus, two, three, four”'}
          disabled={cuesOff}
        >
          <Switch label="Count Into Each Section" on={s.countIntoSections} disabled={cuesOff} set={(v) => setSetting('countIntoSections', v)} />
        </Row>
        <Row title="Song Section Pre-roll" desc="Playing from the beginning of a section gives a bar of count-in, with the tracks fading in">
          <Switch label="Song Section Pre-roll" on={s.sectionPreroll} set={(v) => setSetting('sectionPreroll', v)} />
        </Row>
        <Row
          title="Guide Cue Language"
          desc={
            desktop
              ? 'Spoken section cues a bar ahead of each section, in this computer’s voices'
              : 'Spoken section cues need the desktop app'
          }
          disabled={!desktop}
        >
          <Choice
            label="Guide Cue Language"
            value={desktop ? s.cueLanguage : 'off'}
            options={CUE_LANGUAGES}
            disabled={!desktop}
            set={(v) => setSetting('cueLanguage', v)}
          />
        </Row>
        <Row title="Song Specific Buses" desc="Bus levels, mute and solo are kept per song">
          <Switch label="Song Specific Buses" on={s.songSpecificBuses} set={(v) => setSetting('songSpecificBuses', v)} />
        </Row>
        <Row title="Reference Track" desc="A song’s original mix (a track named Reference or Original) shows in the track list">
          <Switch label="Reference Track" on={s.referenceTrack} set={(v) => setSetting('referenceTrack', v)} />
        </Row>
        <Row title="Default Ambient Pad" desc="The pad for songs that don’t choose their own in Song Settings">
          <Choice label="Default Ambient Pad" value={p.defaultPad} options={p.pads.map((x) => [x.id, x.name])} set={p.setDefaultPad} />
        </Row>
        <Row title="Section Jumps" desc="When a section jump lands while playing">
          <Choice
            label="Section Jumps"
            value={p.jumpMode}
            options={[
              ['immediate', 'Immediately'],
              ['bar', 'At the next bar'],
              ['section', 'At the end of the section'],
            ]}
            set={p.setJumpMode}
          />
        </Row>
      </div>
      <div className="set-col">
        <Row title="Audio Device" desc="Current audio output device">
          <AudioDeviceChoice engine={p.engine} state={p.state} />
        </Row>
        <Row title="Waveform Grid" desc="Overlay measure & beat grid on the waveform; section edits snap to bars">
          <Switch label="Waveform Grid" on={s.waveformGrid} set={(v) => setSetting('waveformGrid', v)} />
        </Row>
        <Row title="Metronome Style VU" desc="Click VU meters flash in sync with the tempo">
          <Switch label="Metronome Style VU" on={s.metronomeVU} set={(v) => setSetting('metronomeVU', v)} />
        </Row>
        <Row title="Song Specific Master Fader" desc="The master fader keeps its own level for each song">
          <Switch label="Song Specific Master Fader" on={s.songSpecificMaster} set={(v) => setSetting('songSpecificMaster', v)} />
        </Row>
        <Row title="Fader Default Level 80%" desc="A song’s faders load at 80% instead of 100%, for headroom">
          <Switch label="Fader Default Level 80%" on={s.faderDefault80} set={(v) => setSetting('faderDefault80', v)} />
        </Row>
        <Row title="Power Saver" desc="Turns off the meters and updates the waveform less often, for older computers">
          <Switch label="Power Saver" on={s.powerSaver} set={(v) => setSetting('powerSaver', v)} />
        </Row>
        <Row title="MIDI Out" desc="Send MIDI start, stop and a program change for each song">
          <Switch label="MIDI Out" on={s.midiOut} set={(v) => setSetting('midiOut', v)} />
        </Row>
        {desktop && (
          <Row
            title="Lumen Boxes"
            desc="Random Countdown before the songs and Outro after them, played in Lumen on this computer or the network"
          >
            <Switch label="Lumen Boxes" on={s.lumenBoxes} set={(v) => setSetting('lumenBoxes', v)} />
          </Row>
        )}
        <Row title="Start Pad Player with Songs" desc="The pad fades in, in the song’s key, when a song begins to play">
          <Switch label="Start Pad Player with Songs" on={p.autoPad} set={p.setAutoPad} />
        </Row>
        <Row title="AutoLink Every Song" desc="Songs set to Cue Next Song start the next song straight away instead">
          <Switch label="AutoLink Every Song" on={p.link} set={p.setLink} />
        </Row>
        <Row title="Fade Length" desc="How long the Fade button takes">
          <Choice
            label="Fade Length"
            value={p.fadeSeconds}
            options={[2, 4, 6, 8, 12].map((n) => [n, `${n} seconds`] as [number, string])}
            set={p.setFadeSeconds}
          />
        </Row>
      </div>
    </div>
  )

  const about = (
    <div className="set-columns">
      <div className="set-col">
        {p.update && (
          <Row title={p.update.ready ? `Player ${p.update.ready} is ready` : `Player ${p.update.version ?? ''}`} desc="Updates are signed and checked before they install">
            <button className={`small ${p.update.ready ? 'primary' : ''}`} onClick={p.update.onOpen}>
              Update…
            </button>
          </Row>
        )}
        {p.exportPlayer && (
          <Row
            title="Export Player"
            desc={
              p.exportPlayer.formats.length
                ? 'A copy of this app to take to another computer, without going online. Your songs stay in the library folder.'
                : 'Only an installed copy of Player can export itself.'
            }
            disabled={!p.exportPlayer.formats.length}
          >
            <div className="set-buttons console-buttons">
              {p.exportPlayer.formats.map((f) => (
                <button key={f} className="small" disabled={p.exportPlayer!.busy} onClick={() => p.exportPlayer!.run(f)}>
                  {EXPORT_LABELS[f]}
                </button>
              ))}
            </div>
          </Row>
        )}
        {p.libraryRoot && (
          <Row title="Song Library" desc={<span className="library-path" title={p.libraryRoot}>{p.libraryRoot}</span>}>
            {p.onRevealLibrary && (
              <button className="small" onClick={p.onRevealLibrary}>
                Open Folder
              </button>
            )}
          </Row>
        )}
        <Row title="Importing" desc="Drop MultiTracks zips, song folders or audio files anywhere on the window to import them">
          <span />
        </Row>
      </div>
      <div className="set-col">
        <div className="set-keys">
          <div className="set-title">Keyboard</div>
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
            <dd>Repeat the current section until turned off</dd>
            <dt>⇧L</dt>
            <dd>Repeat the current section once</dd>
            <dt>F</dt>
            <dd>Fade</dd>
          </dl>
        </div>
      </div>
    </div>
  )

  return (
    <div className="menu-backdrop center settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="dialog settings" role="dialog" aria-label="Settings">
        <header className="set-head">
          <div className="set-tabs" role="tablist">
            {(
              [
                ['general', 'General'],
                ['tracks', 'Tracks'],
                ['buses', 'Buses'],
                ...(desktop ? [['console', 'Console']] : []),
                ['about', 'About'],
              ] as [SettingsTab, string][]
            ).map(([t, name]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {name}
              </button>
            ))}
          </div>
          <button className="set-close" onClick={p.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="set-body">
          {tab === 'general' && general}
          {tab === 'tracks' && <TracksTab state={p.state} />}
          {tab === 'buses' && <BusesTab state={p.state} />}
          {tab === 'console' && desktop && <ConsoleTab />}
          {tab === 'about' && about}
        </div>
      </div>
    </div>
  )
}
