/**
 * App-wide settings (Settings ▸ General), modelled on Playback's General settings. Kept in this
 * browser profile's storage and read through useSettings() / getSettings().
 */
import { useSyncExternalStore } from 'react'

export type ClickSound = 'classic' | 'woodblock' | 'hihat' | 'beep'
/** Spoken section cues: off (the song's own Guide track gives them), or a language and voice. */
export type CueLanguage = 'off' | 'en-female' | 'en-male' | 'es' | 'pt' | 'fr'

export interface Settings {
  /**
   * Click and guide out output 1 (the left), everything else out output 2 (the right), on any
   * device; the bus routing in Settings ▸ Buses waits until it's off. On by default, as in Playback.
   */
  autoPan: boolean
  clickSound: ClickSound
  /** Spoken cues count the bar into each section: "Chorus, two, three, four". */
  countIntoSections: boolean
  /** Playing from the start of a section gives a bar of count-in, with the tracks fading in. */
  sectionPreroll: boolean
  cueLanguage: CueLanguage
  /** Each song keeps its own bus levels, mutes and solos. */
  songSpecificBuses: boolean
  /** Show a song's reference track (a stem named Reference / Original / Full Mix) in the mixer. */
  referenceTrack: boolean
  /** Bar and beat lines over the waveform, and section edits snap to bars. */
  waveformGrid: boolean
  /** The click meters flash on the beat instead of showing level. */
  metronomeVU: boolean
  /** Each song keeps its own master fader. */
  songSpecificMaster: boolean
  /** A song's faders start at 80% instead of 100% (unity). */
  faderDefault80: boolean
  /** No meters, and the playhead and waveform update less often. */
  powerSaver: boolean
  /** Send MIDI (start / stop / program changes) at all. */
  midiOut: boolean
  /** Settings ▸ Tracks: tracks routed to another bus than Playback's, by track name. */
  trackBuses: Record<string, string>
  /** Settings ▸ Buses: the output each bus goes to (Main 1/2 when not set). */
  busOutputs: Record<string, string>
  /** Settings ▸ Buses: buses given another name. */
  busNames: Record<string, string>
}

const DEFAULTS: Settings = {
  autoPan: true,
  clickSound: 'classic',
  countIntoSections: false,
  sectionPreroll: false,
  cueLanguage: 'off',
  songSpecificBuses: true,
  referenceTrack: true,
  waveformGrid: true,
  metronomeVU: false,
  songSpecificMaster: false,
  faderDefault80: false,
  powerSaver: false,
  midiOut: true,
  trackBuses: {},
  busOutputs: {},
  busNames: {},
}

const KEY = 'player.prefs.v1'
const BUSES_PER_SONG_KEY = 'player.prefs.busesPerSong'

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    const out = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const v = saved[k]
      if (typeof v !== typeof DEFAULTS[k] || v === null || Array.isArray(v) !== Array.isArray(DEFAULTS[k])) continue
      // A table of names: only its string entries.
      ;(out as Record<string, unknown>)[k] =
        typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : v
    }
    // Bus levels are kept per song by default (as in Playback): turned on once for settings saved
    // before that; Settings ▸ General can still turn it off.
    if (!localStorage.getItem(BUSES_PER_SONG_KEY)) {
      out.songSpecificBuses = true
      localStorage.setItem(BUSES_PER_SONG_KEY, '1')
      localStorage.setItem(KEY, JSON.stringify(out))
    }
    return out
  } catch {
    return { ...DEFAULTS }
  }
}

let settings = load()
const listeners = new Set<() => void>()

export const getSettings = () => settings

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  if (settings[key] === value) return
  settings = { ...settings, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn())
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => settings,
  )
}
