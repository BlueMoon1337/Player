import { useCallback, useEffect, useState } from 'react'
import type { Engine } from '../audio/engine'
import { KEYS, type Song } from '../audio/types'
import { SongSections } from './SongSections'
import type { SectionScope } from './Timeline'

/** The audio output devices, kept up to date as they come and go. */
export function useAudioDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [needsPermission, setNeedsPermission] = useState(false)

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
  return { devices, needsPermission, refresh }
}

interface EditProps {
  engine: Engine
  song: Song
  /** Makes one undoable edit; `field` joins a burst of typing into one step. */
  edit: (label: string, change: () => void, field?: string) => void
}

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

/** The pads a song can choose from (Song Settings ▸ Pad), and the default's name. */
export interface PadChoices {
  list: { id: string; name: string }[]
  defaultName: string
}

export function EditPanel({ song, edit, pads }: Omit<EditProps, 'engine'> & { pads?: PadChoices }) {
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
                edit(
                  'Change Time Signature',
                  () => (song.timeSig = e.target.value.split('/').map(Number) as [number, number]),
                )
              }
            >
              {['2/4', '3/4', '4/4', '5/4', '6/8', '12/8'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label
            className="wide"
            title="The song's own click stem (such as a MultiTracks Click Track) follows its tempo changes; the generated click follows the BPM above"
          >
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
          {pads && (
            <label title="The pad sound for this song; Default is the Default Ambient Pad in Settings">
              Pad
              <select
                value={song.pad ?? ''}
                onChange={(e) => edit('Change Pad', () => (song.pad = e.target.value || undefined))}
              >
                <option value="">Default ({pads.defaultName})</option>
                {pads.list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
    </div>
  )
}

/** Song Settings (from a song's ••• menu or EDIT's hold menu): the song editor, in a window. */
export function SongSettingsDialog({
  engine,
  song,
  loaded,
  edit,
  pads,
  scope,
  tab: initialTab = 'song',
  onClose,
}: {
  engine: Engine
  song: Song
  /** The loaded song can also add a section at the playhead and play from one. */
  loaded: boolean
  edit: EditProps['edit']
  pads?: PadChoices
  /** Where section changes go: this setlist only, or every setlist. */
  scope?: SectionScope
  tab?: 'song' | 'sections'
  onClose: () => void
}) {
  const [tab, setTab] = useState(initialTab)
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
        <div className="song-tabs" role="tablist">
          {(
            [
              ['song', 'Song'],
              ['sections', 'Sections'],
            ] as const
          ).map(([t, name]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {name}
            </button>
          ))}
        </div>
        {tab === 'song' ? (
          <EditPanel song={song} edit={edit} pads={pads} />
        ) : (
          <SongSections engine={engine} song={song} loaded={loaded} edit={edit} scope={scope} />
        )}
        <div className="dialog-actions">
          <span className="muted">
            Changes save as you make them, and {navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'} undoes them.
          </span>
          <span className="dialog-actions-spacer" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
