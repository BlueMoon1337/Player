import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { desktop } from '../platform'
import type { ConsoleState, ConsoleStrip, ConsoleTarget } from '../platform/types'
import { type MenuEntry, confirmDialog, isAsking, showContextMenu } from './Ask'

/*
 * The console button above the Master fader: mutes and unmutes one channel, bus or DCA group on
 * a Behringer / Midas X32 found on the local network (the main process does the talking; see
 * electron/console.ts). With nothing linked there's no button, and the Master strip looks as it
 * always has, and Player doesn't look for consoles at all until the button is set up from the
 * Master strip's right-click menu. Desktop only.
 */

// ------------------------------------------------------------------------- state

let state: ConsoleState | null = null
let started = false
const listeners = new Set<() => void>()
const setState = (s: ConsoleState) => {
  state = s
  listeners.forEach((fn) => fn())
}

function start() {
  if (started || !desktop) return
  started = true
  desktop.console.onState(setState)
  // A push may beat the first answer; it's newer, so keep it.
  void desktop.console.state().then((s) => {
    if (!state) setState(s)
  })
}

/** What the main process says about consoles; null in the web version. */
export function useConsoleState(): ConsoleState | null {
  start()
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
}

const two = (n: number) => String(n).padStart(2, '0')

/** "Ch 04", "Bus 09", "DCA 1": what the console shows for a strip without a name. */
export const targetLabel = (t: ConsoleTarget) =>
  t.kind === 'channel' ? `Ch ${two(t.number)}` : t.kind === 'bus' ? `Bus ${two(t.number)}` : `DCA ${t.number}`

const stripLabel = (s: ConsoleStrip) => (s.label ? `${targetLabel(s.target)} · ${s.label}` : targetLabel(s.target))

export const modelName = (model: string) => (model === 'X32C' ? 'X32 Compact' : model || 'X32')

const keyOf = (t: ConsoleTarget) => `${t.kind}:${t.number}`

// ------------------------------------------------------------------------ button

export function ConsoleButton() {
  const s = useConsoleState()
  const b = s?.button
  if (!s || !b) return null
  const name = b.label || targetLabel(b.target)
  const live = b.online && b.muted !== null
  const title = !b.online
    ? s.blocked
      ? 'macOS is blocking Player from the local network. Allow Player in System Settings ▸ Privacy & Security ▸ Local Network.'
      : `${b.console} isn’t on the network. ${name} will come back when it is.`
    : b.muted === null
      ? `Asking ${b.console} about ${name}…`
      : `${name} is ${b.muted ? 'muted' : 'on'} on ${b.console}. Click to ${b.muted ? 'unmute' : 'mute'} it.`
  return (
    <button
      className={`console-btn ${b.online ? '' : 'offline'} ${b.muted ? 'muted' : ''} ${b.online && b.muted === null ? 'waiting' : ''}`}
      // Not `disabled` while offline: the right-click menu still has to work.
      aria-disabled={!live}
      aria-pressed={!!b.muted}
      aria-label={`${name} on the console: ${!b.online ? 'not found' : b.muted ? 'muted' : 'on'}`}
      title={title}
      onClick={() => {
        if (live) void desktop!.console.setMuted(!b.muted)
      }}
      onContextMenu={(e) => {
        e.stopPropagation()
        showContextMenu(e, consoleMenu(s))
      }}
    >
      <span className="console-dot" aria-hidden="true" />
      <span className="console-name">{name}</span>
    </button>
  )
}

/** The console button's right-click menu; the Master strip shows it too, to set the button up. */
export function consoleMenu(s: ConsoleState | null): MenuEntry[] {
  if (!desktop || !s) return []
  const b = s.button
  // The console to link: the button's own, else one on the network now, else (no button yet)
  // the picker looks for one.
  const name = b?.console ?? s.online[0] ?? null
  const known = s.consoles.find((c) => c.name === name)
  // Changing a button means reaching its console; setting one up can start by looking for it.
  const offline = !!b && !s.online.includes(b.console)
  const items: MenuEntry[] = [
    {
      label: b ? 'Change Console Button…' : 'Console Button…',
      disabled: offline,
      hint: offline ? 'not on the network' : undefined,
      onClick: async () => {
        const picked = await pickConsoleStrip(name, b?.target ?? null)
        if (picked) await desktop!.console.link(picked.name, picked.target)
      },
    },
  ]
  if (b) items.push({ label: 'Remove Console Button', onClick: () => void desktop!.console.link(b.console, null) })
  if (known) {
    items.push('separator', {
      label: `Forget “${known.name}”…`,
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({
          title: `Forget “${known.name}”?`,
          message: 'Player stops remembering this console and what its button was set to. If it’s found again, Player asks about it as a new console.',
          confirmLabel: 'Forget',
          danger: true,
        })
        if (ok) await desktop!.console.forget(known.name)
      },
    })
  }
  return items
}

// ------------------------------------------------------------------ new consoles

/**
 * Asks about a console Player hasn't seen before, once: link a strip to the button, or not.
 * Never while audio plays (a song or the pad) or another question is open; it waits for those.
 */
export function ConsoleWatcher({ playing }: { playing: boolean }) {
  const s = useConsoleState()
  const found = s?.newConsole ?? null
  const busy = useRef(false)
  useEffect(() => {
    if (!found || !desktop) return
    const tryAsk = async () => {
      if (busy.current || playing || isAsking() || pending) return
      busy.current = true
      try {
        const yes = await confirmDialog({
          title: 'New console found',
          message: `${modelName(found.model)} “${found.name}” is on the network. Do you want the button above the Master fader to mute and unmute one of its channels, buses or DCA groups?`,
          confirmLabel: 'Choose…',
          cancelLabel: 'Not Now',
        })
        const picked = yes ? await pickConsoleStrip(found.name, null) : undefined
        // Remembered either way, so Player doesn't ask again.
        await desktop!.console.link(found.name, picked?.name === found.name ? picked.target : null)
      } catch {
        // It went off the network; it'll be asked about next time it's seen.
      } finally {
        busy.current = false
      }
    }
    void tryAsk()
    const id = setInterval(() => void tryAsk(), 1500)
    return () => clearInterval(id)
  }, [found?.name, playing])
  return null
}

// ------------------------------------------------------------------------ picker

/** The console and strip chosen: a strip, or null for "nothing". */
type Picked = { name: string; target: ConsoleTarget | null }

interface Pending {
  /** The console to choose a strip on; null to look for one first. */
  consoleName: string | null
  current: ConsoleTarget | null
  seq: number
  /** What was chosen, undefined if cancelled. */
  resolve: (p: Picked | undefined) => void
}

let pending: Pending | null = null
let seq = 0
const pickerListeners = new Set<() => void>()
const setPending = (p: Pending | null) => {
  pending = p
  pickerListeners.forEach((fn) => fn())
}

/**
 * Asks which strip on a console the button should mute (with `consoleName` null, on the first
 * console found by looking for one): the console and strip, or undefined if cancelled.
 */
export function pickConsoleStrip(consoleName: string | null, current: ConsoleTarget | null) {
  return new Promise<Picked | undefined>((resolve) => {
    pending?.resolve(undefined)
    setPending({ consoleName, current, seq: ++seq, resolve })
  })
}

/** How long the picker looks for a console before saying none was found. */
const LOOK_MS = 15_000

export function ConsoleLinkHost() {
  const p = useSyncExternalStore(
    (fn) => {
      pickerListeners.add(fn)
      return () => pickerListeners.delete(fn)
    },
    () => pending,
  )
  return p ? <PickerBox key={p.seq} p={p} /> : null
}

const GROUPS: { kind: ConsoleTarget['kind']; title: string }[] = [
  { kind: 'channel', title: 'Channels' },
  { kind: 'bus', title: 'Mix Buses' },
  { kind: 'dca', title: 'DCA Groups' },
]

function PickerBox({ p }: { p: Pending }) {
  const s = useConsoleState()
  const [strips, setStrips] = useState<ConsoleStrip[] | null>(null)
  const [error, setError] = useState('')
  const [choice, setChoice] = useState(p.current ? keyOf(p.current) : '')
  // The console: the one asked for, else the first one found once looking.
  const [found, setFound] = useState<string | null>(p.consoleName)
  const name = found ?? s?.online[0] ?? null
  const model = (name && (s?.models[name] ?? s?.consoles.find((c) => c.name === name)?.model)) || ''

  const answer = (picked: Picked | undefined) => {
    if (pending === p) setPending(null)
    p.resolve(picked)
  }
  const ok = () => {
    if (!name || !strips) return
    const hit = strips.find((x) => keyOf(x.target) === choice)
    answer({ name, target: hit ? hit.target : null })
  }

  // Look for consoles while the picker is open (Player doesn't otherwise, until a button is set up).
  useEffect(() => {
    void desktop!.console.search()
    const renew = setInterval(() => void desktop!.console.search(), 30_000)
    return () => clearInterval(renew)
  }, [])

  // No console found in a while: say so (it keeps looking, and shows one that turns up).
  useEffect(() => {
    if (name) return
    const t = setTimeout(
      () =>
        setError(
          s?.blocked
            ? 'macOS is blocking Player from the local network. Allow Player in System Settings ▸ Privacy & Security ▸ Local Network, then try again.'
            : 'No console found yet. Check the X32 is on and on the same network as this computer. Player keeps looking while this is open.',
        ),
      LOOK_MS,
    )
    return () => clearTimeout(t)
  }, [name, s?.blocked])

  useEffect(() => {
    if (!name) return
    setFound(name) // stay with this console, even if another one answers too
    setError('')
    setStrips(null)
    desktop!.console.strips(name).then(setStrips, () =>
      setError(`Couldn’t reach “${name}”. Check it’s on and on the same network, then try again.`),
    )
  }, [name])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer(undefined)
      else if (e.key === 'Enter' && strips) ok()
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="menu-backdrop center ask-backdrop" onKeyDown={(e) => e.stopPropagation()}>
      <div className="dialog ask console-link" role="dialog" aria-modal="true" aria-label="Console Button">
        <h3 className="ask-title">Console Button</h3>
        <p className="ask-message">
          {name
            ? <>Choose what the button above the Master fader mutes and unmutes on {modelName(model)} “{name}”.</>
            : 'The button above the Master fader can mute and unmute a channel, bus or DCA group on a Behringer or Midas X32 on this network.'}
        </p>
        {error ? (
          <p className="ask-message console-error">{error}</p>
        ) : !name ? (
          <p className="ask-message">Looking for consoles on the network…</p>
        ) : !strips ? (
          <p className="ask-message">Reading names from the console…</p>
        ) : (
          <select autoFocus value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Strip to mute">
            <option value="">Nothing (no button)</option>
            {GROUPS.map((g) => (
              <optgroup key={g.kind} label={g.title}>
                {strips
                  .filter((s) => s.target.kind === g.kind)
                  .map((s) => (
                    <option key={keyOf(s.target)} value={keyOf(s.target)}>
                      {stripLabel(s)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        )}
        <div className="dialog-actions">
          <span className="dialog-actions-spacer" />
          <button onClick={() => answer(undefined)}>Cancel</button>
          <button className="primary" disabled={!strips} onClick={ok}>
            {choice ? 'Link' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
