import { useCallback, useEffect, useState } from 'react'
import type { Engine, EngineState, JumpMode } from '../audio/engine'
import { type Bus, KEYS, type Song, busLabel, busOptions, formatTime, sectionColor, uid } from '../audio/types'

/** Outputs: the audio device, and which output each click / stem channel goes to. */
export function OutputsDialog({ engine, state, onClose }: { engine: Engine; state: EngineState; onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [needsPermission, setNeedsPermission] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? []
    const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
    setDevices(outs)
    // Browsers hide device names (and most devices) until media permission is granted.
    setNeedsPermission(all.every((d) => !d.label))
  }, [])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [refresh])

  const options = busOptions(state.outputCount)
  const routable = state.channels.filter((c) => c.group === 'stem' || c.id === 'click')
  const isMonitor = (name: string, group: string) => group === 'click' || /guide|cue/i.test(name)
  const preset = (monitor: Bus, tracks: Bus) => {
    for (const c of routable) engine.setChannel(c.id, { bus: isMonitor(c.name, c.group) ? monitor : tracks })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="menu-backdrop center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog outputs panel" role="dialog" aria-label="Outputs">
        <div className="panel-head">
          <h3>Outputs</h3>
          {engine.canSelectOutput ? (
            <label>
              Audio device
              <select
                value={state.outputDeviceId}
                onChange={(e) => {
                  const opt = e.target.selectedOptions[0]
                  setError(null)
                  engine.setOutputDevice(e.target.value, opt?.textContent ?? '').catch((err: Error) => setError(err.message))
                }}
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Audio device'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>This browser can't choose an output device; it plays through the system default.</p>
          )}
          {needsPermission && engine.canSelectOutput && (
            <button
              className="small"
              onClick={async () => {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                  stream.getTracks().forEach((t) => t.stop())
                } catch {
                  setError('Device access was not granted')
                }
                void refresh()
              }}
            >
              Show all audio devices
            </button>
          )}
          <p>
            {state.outputCount} output{state.outputCount === 1 ? '' : 's'} on this device.
            {state.outputCount <= 2 && ' Choose a multi-output audio interface to send click and guide to their own outputs.'}
          </p>
          {error && <p className="panel-error">{error}</p>}
          {state.outputCount >= 4 ? (
            <button className="small" onClick={() => preset('pair:1', 'main')}>
              Click/Guide → Out 3/4 · Tracks → Main
            </button>
          ) : (
            <button className="small" onClick={() => preset('mono:0', 'mono:1')}>
              Click/Guide left · Tracks right
            </button>
          )}
          <button className="small" onClick={() => preset('main', 'main')}>
            All to Main
          </button>
        </div>
        <div className="bus-grid">
          {routable.map((c) => {
            const missing = !options.includes(c.settings.bus)
            return (
              <label key={c.id} className="bus-row">
                <span>{c.name}</span>
                <select value={c.settings.bus} onChange={(e) => engine.setChannel(c.id, { bus: e.target.value as Bus })}>
                  {missing && <option value={c.settings.bus}>{busLabel(c.settings.bus)} (not on this device → Main)</option>}
                  {options.map((b) => (
                    <option key={b} value={b}>
                      {busLabel(b)}
                    </option>
                  ))}
                </select>
              </label>
            )
          })}
        </div>
        <div className="dialog-actions">
          <button className="small primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

interface EditProps {
  engine: Engine
  song: Song
  /** Makes one undoable edit; `field` joins a burst of typing into one step. */
  edit: (label: string, change: () => void, field?: string) => void
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

/**
 * A number box you can type into freely: it shows what's typed, applies each value that's in
 * range as you go, and shows the real value again when you leave it.
 */
function NumberField({
  value,
  min,
  max,
  step,
  onValue,
}: {
  value: number
  min: number
  max: number
  step: number
  onValue: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value)
        const v = Number(e.target.value)
        if (e.target.value.trim() !== '' && v >= min && v <= max) onValue(v)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

export function EditPanel({ engine, song, edit, sectionsEditable = true }: EditProps & { sectionsEditable?: boolean }) {
  const sortSections = () => song.sections.sort((a, b) => a.start - b.start)
  return (
    <div className="panel edit-panel">
      <div className="panel-head">
        <label>
          Title
          <input
            value={song.title}
            onChange={(e) => edit('Rename Song', () => (song.title = e.target.value), 'title')}
          />
        </label>
        <label>
          Artist
          <input
            value={song.artist ?? ''}
            onChange={(e) => edit('Change Artist', () => (song.artist = e.target.value || undefined), 'artist')}
          />
        </label>
        <label>
          Album
          <input
            value={song.album ?? ''}
            onChange={(e) => edit('Change Album', () => (song.album = e.target.value || undefined), 'album')}
          />
        </label>
        <div className="row">
          <label>
            Key
            <select value={song.key} onChange={(e) => edit('Change Key', () => (song.key = e.target.value))}>
              {/* Keys from a MultiTracks name ("Am", "F#") stay as written. */}
              {[...((KEYS as readonly string[]).includes(song.key) ? [] : [song.key]), ...KEYS].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            BPM
            <NumberField
              min={30}
              max={300}
              step={0.1}
              value={song.bpm}
              onValue={(v) => edit('Change Tempo', () => (song.bpm = v), 'bpm')}
            />
          </label>
          <label>
            Time sig
            <select
              value={song.timeSig.join('/')}
              onChange={(e) =>
                edit('Change Time Signature', () => (song.timeSig = e.target.value.split('/').map(Number) as [number, number]))
              }
            >
              {['2/4', '3/4', '4/4', '5/4', '6/8', '12/8'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="wide" title="The song's own click stem (such as a MultiTracks Click Track) follows its tempo changes; the generated click follows the BPM above">
            Click
            <select
              value={song.clickStem ?? ''}
              onChange={(e) => edit('Change Click', () => (song.clickStem = e.target.value || null))}
            >
              <option value="">Generated</option>
              {(song.stems.length ? song.stems : (song.stemFiles ?? [])).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label title="Where bar 1 beat 1 falls in the audio, in seconds">
            Click offset
            <NumberField
              min={0}
              max={Math.max(0, song.duration - 0.1)}
              step={0.001}
              value={song.clickOffset}
              onValue={(v) => edit('Change Click Offset', () => (song.clickOffset = v), 'click-offset')}
            />
          </label>
        </div>
        {sectionsEditable && (
          <button
            className="small"
            onClick={() => {
              const at = engine.position
              if (song.sections.some((s) => Math.abs(s.start - at) < 0.05)) return
              edit('Add Section', () => {
                song.sections.push({ id: uid('sec'), name: 'Verse 1', start: at })
                sortSections()
              })
            }}
          >
            + Section at playhead
          </button>
        )}
      </div>
      {!sectionsEditable ? (
        <p className="hint section-hint">Load this song to change its sections here or in the song map.</p>
      ) : (
      <div className="section-list">
        {song.sections.map((s, i) => (
          <div key={s.id} className="section-row" style={{ ['--c' as string]: sectionColor(s.name) }}>
            <input
              list="section-names"
              value={s.name}
              onChange={(e) => edit('Rename Section', () => (s.name = e.target.value), `section-name:${s.id}`)}
            />
            <input
              type="number"
              step={0.01}
              min={0}
              value={Math.round(s.start * 1000) / 1000}
              disabled={i === 0}
              onChange={(e) =>
                edit(
                  'Move Section',
                  () => (s.start = Math.max(0, Math.min(song.duration - 0.1, Number(e.target.value)))),
                  `section-start:${s.id}`,
                )
              }
              onBlur={() => edit('Move Section', sortSections, `section-start:${s.id}`)}
            />
            <span className="section-time">{formatTime(s.start)}</span>
            <button
              title="Move section start to playhead"
              disabled={i === 0}
              onClick={() =>
                edit('Move Section', () => {
                  s.start = engine.position
                  sortSections()
                })
              }
            >
              ⇥
            </button>
            <button
              title="Delete section"
              disabled={song.sections.length === 1}
              onClick={() =>
                edit(`Delete Section “${s.name}”`, () => {
                  song.sections.splice(i, 1)
                  song.sections[0].start = 0
                })
              }
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
      )}
    </div>
  )
}

/** Song Settings (from a song's ••• menu or EDIT's hold menu): the song editor, in a window. */
export function SongSettingsDialog({
  engine,
  song,
  loaded,
  edit,
  onClose,
}: {
  engine: Engine
  song: Song
  /** Sections are edited against the playhead, so only for the song that's loaded. */
  loaded: boolean
  edit: EditProps['edit']
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.ask-backdrop')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="menu-backdrop center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog song-settings" role="dialog" aria-label="Song Settings">
        <div className="dialog-head">
          <h3>Song Settings</h3>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <EditPanel engine={engine} song={song} edit={edit} sectionsEditable={loaded} />
        <div className="dialog-actions">
          <span className="muted">Changes save as you make them, and {navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'} undoes them.</span>
          <span className="dialog-actions-spacer" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

interface MenuProps {
  /** AutoLink after every song whose card says Cue Next Song. */
  link: boolean
  setLink: (v: boolean) => void
  onOutputs: () => void
  jumpMode: JumpMode
  setJumpMode: (m: JumpMode) => void
  fadeSeconds: number
  setFadeSeconds: (s: number) => void
  /** Desktop only: where songs are stored. */
  libraryRoot?: string | null
  onRevealLibrary?: () => void
  /** Desktop only: this version, whether a newer one is ready, and opening the Update window. */
  update?: { version: string | null; ready: string | null; onOpen: () => void }
  onClose: () => void
}

export function Menu({
  link,
  setLink,
  onOutputs,
  jumpMode,
  setJumpMode,
  fadeSeconds,
  setFadeSeconds,
  libraryRoot,
  onRevealLibrary,
  update,
  onClose,
}: MenuProps) {
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        {update && (
          <div className={`menu-update ${update.ready ? 'ready' : ''}`}>
            <span>
              {update.ready ? (
                <>
                  <b>Player {update.ready}</b> is ready to install
                </>
              ) : (
                <>Player {update.version ?? ''}</>
              )}
            </span>
            <button className={`small ${update.ready ? 'primary' : ''}`} onClick={update.onOpen}>
              Update…
            </button>
          </div>
        )}
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
        <label className="check">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> AutoLink every song
        </label>
        <p className="hint">Songs whose end is set to Cue Next Song start the next song straight away instead.</p>
        <button className="small" onClick={onOutputs}>
          Outputs…
        </button>
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
          <dd>Repeat the current section until turned off</dd>
          <dt>⇧L</dt>
          <dd>Repeat the current section once</dd>
          <dt>F</dt>
          <dd>Fade out</dd>
        </dl>
        {libraryRoot && (
          <>
            <h4>Song library</h4>
            <p className="hint library-path" title={libraryRoot}>
              {libraryRoot}
            </p>
            {onRevealLibrary && (
              <button className="small" onClick={onRevealLibrary}>
                Open library folder
              </button>
            )}
          </>
        )}
        <p className="hint">Drop audio files anywhere on the window to import them as a new song.</p>
        <button className="small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
