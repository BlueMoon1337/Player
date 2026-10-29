/**
 * Settings ▸ Tracks and Settings ▸ Buses, as in Playback: which bus each track goes to, and which
 * output of the audio device each bus goes to.
 */
import { useMemo, useState } from 'react'
import type { EngineState } from '../audio/engine'
import {
  BUSES,
  type BusId,
  TRACK_BUSES,
  TRACK_DEFAULTS,
  autoPanOutput,
  busName,
  busOutput,
  defaultTrackBus,
  outputLabel,
  trackBus,
} from '../audio/routing'
import { type Bus, busOptions, busTopChannel } from '../audio/types'
import { getSettings, setSetting, useSettings } from '../settings'
import { alertDialog, confirmDialog, promptDialog, showContextMenu } from './Ask'

/** Auto Pan decides the outputs on a stereo device; routing waits until it's off. */
export const busSettingsLocked = () =>
  alertDialog({ title: 'Bus Settings Locked', message: 'Please disable Auto Pan to change routings.' })

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

const Chevron = () => (
  <svg className="set-chevron" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 5l7 7-7 7" />
  </svg>
)

/** A row you tap to open its choices: the name, its value and a ›. */
function LinkRow(p: { name: string; value: string; changed?: boolean; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void; children?: React.ReactNode }) {
  return (
    <button className="set-item" onClick={p.onClick} onContextMenu={p.onContextMenu}>
      {p.children}
      <span className="set-item-name">{p.name}</span>
      <span className={`set-item-value ${p.changed ? 'changed' : ''}`}>{p.value}</span>
      <Chevron />
    </button>
  )
}

/** A chosen row's own page: back to the list, its name, and what can be chosen for it. */
function SubPage(p: { back: string; title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="set-sub">
      <div className="set-sub-head">
        <button className="set-back" onClick={p.onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {p.back}
        </button>
        <h3>{p.title}</h3>
      </div>
      {p.children}
    </div>
  )
}

function Option(p: { label: string; desc?: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`set-item option ${p.on ? 'on' : ''}`} role="menuitemradio" aria-checked={p.on} onClick={p.onClick}>
      <span className="set-item-name">
        {p.label}
        {p.desc && <span className="set-item-desc">{p.desc}</span>}
      </span>
      {p.on && <span className="set-check">✓</span>}
    </button>
  )
}

/** Two columns, the first half of the list on the left, as Playback lays them out. */
function Columns<T>({ items, split, row }: { items: T[]; split?: number; row: (item: T) => React.ReactNode }) {
  const half = split ?? Math.ceil(items.length / 2)
  return (
    <div className="set-columns set-lists">
      <div className="set-col set-list">{items.slice(0, half).map(row)}</div>
      <div className="set-col set-list">{items.slice(half).map(row)}</div>
    </div>
  )
}

/** Settings ▸ Tracks: every track name and its bus; tap one to send it to another bus. */
export function TracksTab({ state }: { state: EngineState }) {
  const s = useSettings()
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  // Playback's named tracks, and the loaded song's (and any routed by hand) that it doesn't name.
  const names = useMemo(() => {
    const all = new Map(TRACK_DEFAULTS.map((t) => [t.name.toLowerCase(), t.name]))
    const more = [...Object.keys(s.trackBuses), ...state.channels.filter((c) => c.group === 'stem').map((c) => c.name)]
    for (const n of more) if (!all.has(n.trim().toLowerCase())) all.set(n.trim().toLowerCase(), n.trim())
    return [...all.values()].sort(byName)
  }, [s.trackBuses, state.channels])

  const route = (name: string, bus: BusId) => {
    // Routing a track back to its default forgets the change.
    const rest = Object.fromEntries(Object.entries(getSettings().trackBuses).filter(([n]) => n.toLowerCase() !== name.toLowerCase()))
    setSetting('trackBuses', bus === defaultTrackBus(name) ? rest : { ...rest, [name]: bus })
  }

  if (open) {
    const current = trackBus(open, s.trackBuses)
    const def = defaultTrackBus(open)
    return (
      <SubPage back="Tracks" title={open} onBack={() => setOpen(null)}>
        <p className="set-sub-desc">
          The bus “{open}” goes to, in every song. By default: {busName(def, s.busNames)}.
        </p>
        <Columns
          items={[...TRACK_BUSES]}
          row={(b) => (
            <Option
              key={b.id}
              label={busName(b.id, s.busNames)}
              on={b.id === current}
              onClick={() => {
                route(open, b.id)
                setOpen(null)
              }}
            />
          )}
        />
      </SubPage>
    )
  }

  const q = filter.trim().toLowerCase()
  const shown = names
    .map((name) => ({ name, bus: trackBus(name, s.trackBuses) }))
    .filter((t) => !q || t.name.toLowerCase().includes(q) || busName(t.bus, s.busNames).toLowerCase().includes(q))
  const changed = Object.keys(s.trackBuses).length > 0

  return (
    <div className="set-routing">
      <label className="set-filter">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
        </svg>
        <input type="search" placeholder="Filter" aria-label="Filter tracks" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {shown.length ? (
        <Columns
          items={shown}
          row={(t) => (
            <LinkRow
              key={t.name}
              name={t.name}
              value={busName(t.bus, s.busNames)}
              changed={t.bus !== defaultTrackBus(t.name)}
              onClick={() => setOpen(t.name)}
            />
          )}
        />
      ) : (
        <p className="set-empty">No tracks match “{filter}”.</p>
      )}
      <div className="set-foot">
        <button
          className="set-outline"
          disabled={!changed}
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Reset Default Settings?',
              message: 'Every track goes back to the bus it goes to by default.',
              confirmLabel: 'Reset',
            })
            if (ok) setSetting('trackBuses', {})
          }}
        >
          Reset Default Settings
        </button>
      </div>
    </div>
  )
}

/** "1", "3/4": and where it really plays when the device hasn't that output. */
function outputText(bus: Bus, outputs: number): string {
  return busTopChannel(bus) < outputs ? outputLabel(bus) : `${outputLabel(bus)} → 1/2`
}

const outputDesc = (bus: Bus) => (bus === 'main' ? 'Stereo · Main' : bus.startsWith('pair') ? 'Stereo' : 'Mono')

/** Settings ▸ Buses: each bus's output; tap one to route it, or assign several at once. */
export function BusesTab({ state }: { state: EngineState }) {
  const s = useSettings()
  const [open, setOpen] = useState<BusId | null>(null)
  const [picking, setPicking] = useState<Set<BusId> | null>(null)
  const [assignTo, setAssignTo] = useState<Bus>('main')
  const locked = state.autoPan
  const options = busOptions(state.outputCount)

  const outputOf = (id: BusId): Bus => (locked ? autoPanOutput(id) : busOutput(id, s.busOutputs))
  const setOutputs = (ids: Iterable<BusId>, bus: Bus) => {
    const next = { ...getSettings().busOutputs }
    for (const id of ids) next[id] = bus
    setSetting('busOutputs', next)
  }
  const rename = async (id: BusId) => {
    const name = await promptDialog({
      title: 'Rename Bus',
      message: `Its name in the Buses view and the Tracks list. Leave it as “${busName(id, {})}” for the usual name.`,
      defaultValue: busName(id, getSettings().busNames),
      confirmLabel: 'Rename',
    })
    if (name === null) return
    const { [id]: _, ...rest } = getSettings().busNames
    setSetting('busNames', name === busName(id, {}) ? rest : { ...rest, [id]: name })
  }

  if (open) {
    const current = busOutput(open, s.busOutputs)
    return (
      <SubPage back="Buses" title={busName(open, s.busNames)} onBack={() => setOpen(null)}>
        <div className="set-sub-actions">
          <button className="small" onClick={() => void rename(open)}>
            Rename…
          </button>
        </div>
        <p className="set-sub-desc">
          The output of this {state.outputCount}-output device that {busName(open, s.busNames)} plays out of.
        </p>
        <Columns
          items={options}
          row={(b) => (
            <Option
              key={b}
              label={outputLabel(b)}
              desc={outputDesc(b)}
              on={b === current}
              onClick={() => {
                setOutputs([open], b)
                setOpen(null)
              }}
            />
          )}
        />
        {!options.includes(current) && (
          <p className="set-sub-desc">
            Routed to {outputLabel(current)}, which this device doesn’t have: it plays out of 1/2 until that device is back.
          </p>
        )}
      </SubPage>
    )
  }

  const left = BUSES.findIndex((b) => b.id === 'ag')
  return (
    <div className="set-routing">
      <Columns
        items={[...BUSES]}
        split={left}
        row={(b) => {
          const on = picking?.has(b.id)
          return (
            <LinkRow
              key={b.id}
              name={busName(b.id, s.busNames)}
              value={locked ? outputLabel(outputOf(b.id)) : outputText(outputOf(b.id), state.outputCount)}
              onClick={() => {
                if (picking) {
                  const next = new Set(picking)
                  if (on) next.delete(b.id)
                  else next.add(b.id)
                  setPicking(next)
                } else if (locked) void busSettingsLocked()
                else setOpen(b.id)
              }}
              onContextMenu={(e) => showContextMenu(e, [{ label: 'Rename…', onClick: () => void rename(b.id) }])}
            >
              {picking && <span className={`set-pick ${on ? 'on' : ''}`} aria-hidden="true" />}
            </LinkRow>
          )
        }}
      />
      {locked && (
        <p className="set-note">
          <b>Auto Pan is on</b> (General): click, guide and cues go out output 1 (left), mixed to mono, and all tracks and the
          pad out output 2 (right). Use a 1/8&quot; TRS to dual 1/4&quot; TS cable and direct boxes (or two line inputs) to send
          each side to the sound system: the left to the in-ears, the right to front of house.
        </p>
      )}
      <div className="set-foot">
        <span className="set-foot-info">
          {state.outputCount} output{state.outputCount === 1 ? '' : 's'} on this device
          {state.outputCount <= 2 && !locked ? ' · choose a multi-output interface in General for more' : ''}
        </span>
        {picking ? (
          <>
            <label className="set-assign">
              Assign {picking.size || 'the chosen'} bus{picking.size === 1 ? '' : 'es'} to
              <select className="set-choice" value={assignTo} onChange={(e) => setAssignTo(e.target.value as Bus)}>
                {options.map((b) => (
                  <option key={b} value={b}>
                    {outputLabel(b)} ({outputDesc(b)})
                  </option>
                ))}
              </select>
            </label>
            <button className="small" onClick={() => setPicking(null)}>
              Cancel
            </button>
            <button
              className="small primary"
              disabled={!picking.size}
              onClick={() => {
                setOutputs(picking, assignTo)
                setPicking(null)
              }}
            >
              Assign
            </button>
          </>
        ) : (
          <button className="set-outline" onClick={() => (locked ? void busSettingsLocked() : setPicking(new Set()))}>
            Assign Multiple Buses
          </button>
        )}
      </div>
    </div>
  )
}
