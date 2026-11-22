import { useEffect, useState, useSyncExternalStore } from 'react'
import { desktop } from '../platform'
import type { LumenState, LumenWhat } from '../platform/types'
import { useSettings } from '../settings'

/*
 * The Random Countdown box (before the first song) and the Outro box (after the last one): they
 * play a random countdown video or the outro in Lumen, the presentation app, on this computer or
 * another one on the local network (electron/lumen.ts). Desktop only; Settings ▸ General ▸ Lumen
 * Boxes hides them, and then Player doesn't look for Lumen.
 */

let state: LumenState | null = null
let started = false
const listeners = new Set<() => void>()
const setState = (s: LumenState) => {
  state = s
  listeners.forEach((fn) => fn())
}

function start() {
  if (started || !desktop) return
  started = true
  desktop.lumen.onState(setState)
  void desktop.lumen.state().then((s) => {
    if (!state) setState(s)
  })
}

function useLumenState(): LumenState | null {
  start()
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
}

/** How many boxes are showing: Lumen is looked for while any is. */
let showing = 0

const TITLES: Record<LumenWhat, string> = { 'random-countdown': 'Random Countdown', outro: 'Outro' }

/** What a box says under its title, and whether it can be clicked. */
function status(s: LumenState | null, what: LumenWhat): { text: string; tip: string; ready: boolean } {
  const l = s?.lumen
  if (!l) {
    return s?.blocked
      ? { text: 'Network blocked', tip: 'macOS is blocking Player from the local network. Allow Player in System Settings ▸ Privacy & Security ▸ Local Network.', ready: false }
      : { text: 'Lumen not found', tip: 'Lumen isn’t answering on this computer or the network. Open Lumen (1.0.17 or later); click to try anyway.', ready: true }
  }
  const on = l.name
  if (!l.ready) return { text: 'Lumen is starting', tip: `Lumen on “${on}” is still starting.`, ready: false }
  if (!l.allowed) {
    return { text: 'Off in Lumen', tip: `Lumen on “${on}” is set not to let Player play anything: turn on “Player can play the countdown and outro” in its Timers tab.`, ready: false }
  }
  if (what === 'random-countdown') {
    return l.countdowns
      ? { text: `Lumen · ${l.countdowns} video${l.countdowns === 1 ? '' : 's'}`, tip: `Plays one of the ${l.countdowns} countdown videos in Lumen on “${on}”, at random.`, ready: true }
      : { text: 'No countdowns in Lumen', tip: `Lumen on “${on}” has no countdown videos yet (Media ▸ Countdowns).`, ready: false }
  }
  return l.outro
    ? { text: `Lumen · ${l.outro}`, tip: `Plays the outro “${l.outro}” in Lumen on “${on}”.`, ready: true }
    : { text: 'No outro in Lumen', tip: `Lumen on “${on}” has no outro yet (Media ▸ Outro).`, ready: false }
}

export function LumenBox({ what }: { what: LumenWhat }) {
  const settings = useSettings()
  const s = useLumenState()
  const on = !!desktop && settings.lumenBoxes
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!on) return
    if (showing++ === 0) desktop!.lumen.setLooking(true)
    return () => {
      if (--showing === 0) desktop!.lumen.setLooking(false)
    }
  }, [on])

  useEffect(() => {
    if (!result) return
    const t = setTimeout(() => setResult(null), result.ok ? 2500 : 6000)
    return () => clearTimeout(t)
  }, [result])

  if (!on) return null
  const st = status(s, what)
  const play = async () => {
    if (busy || !st.ready) return
    setBusy(true)
    try {
      const r = await desktop!.lumen.play(what)
      setResult(r.ok ? { ok: true, text: 'Playing in Lumen' } : { ok: false, text: r.message ?? 'Lumen didn’t play it.' })
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const text = busy ? 'Asking Lumen…' : result ? result.text : st.text
  return (
    <div className={`song-card lumen-box ${what} ${st.ready ? '' : 'unavailable'} ${result ? (result.ok ? 'played' : 'failed') : ''}`}>
      <button
        className="song-card-main"
        onClick={play}
        aria-disabled={!st.ready}
        title={result && !result.ok ? result.text : st.tip}
      >
        <span className="lumen-icon" aria-hidden="true">
          {what === 'random-countdown' ? <ShuffleIcon /> : <OutroIcon />}
        </span>
        <div className="song-card-text">
          <div className="song-card-title">{TITLES[what]}</div>
          <div className="song-card-meta lumen-status">{text}</div>
        </div>
      </button>
    </div>
  )
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
    </svg>
  )
}

function OutroIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9l5 3-5 3z" fill="currentColor" />
    </svg>
  )
}
