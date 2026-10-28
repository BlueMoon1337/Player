/**
 * App-wide settings (Settings ▸ General), modelled on Playback's General settings. Kept in this
 * browser profile's storage and read through useSettings() / getSettings().
 */
import { useSyncExternalStore } from 'react'

export type ClickSound = 'classic' | 'woodblock' | 'hihat' | 'beep'
/** Spoken section cues: off (the song's own Guide track gives them), or a language and voice. */
export type CueLanguage = 'off' | 'en-female' | 'en-male' | 'es' | 'pt' | 'fr'

export interface Settings {
  /** Click and guide out the left output, everything else out the right (a stereo output). */
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
}

const DEFAULTS: Settings = {
  autoPan: false,
  clickSound: 'classic',
  countIntoSections: false,
  sectionPreroll: false,
  cueLanguage: 'off',
  songSpecificBuses: false,
  referenceTrack: true,
  waveformGrid: true,
  metronomeVU: false,
  songSpecificMaster: false,
  faderDefault80: false,
  powerSaver: false,
  midiOut: true,
}

const KEY = 'player.prefs.v1'

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    const out = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof saved[k] === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = saved[k]
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
