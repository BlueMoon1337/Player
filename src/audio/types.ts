export interface Section {
  id: string
  name: string
  /** Start time in seconds from the top of the song. */
  start: number
}

export interface Stem {
  id: string
  name: string
  buffer: AudioBuffer
  /** File name inside the song's library folder (desktop). */
  file?: string
}

export interface Song {
  id: string
  title: string
  artist?: string
  key: string
  bpm: number
  /** [beats per bar, beat unit] */
  timeSig: [number, number]
  /** Seconds at which bar 1, beat 1 of the click falls. */
  clickOffset: number
  duration: number
  sections: Section[]
  /** Audio stems. Empty until the song is loaded (demo and library songs load lazily). */
  stems: Stem[]
  /** Library stem files, kept while `stems` is unloaded so the song can be reloaded from disk. */
  stemFiles?: { id: string; name: string; file: string }[]
  artwork: string
  /**
   * The stem that is the click (a MultiTracks "Click Track"): it goes through the Click fader and
   * routing instead of the generated click. Null or missing: the click is generated from the tempo.
   */
  clickStem?: string | null
  /** demo: synthesized; user: imported in a browser (memory only); library: saved on disk. */
  source: 'demo' | 'user' | 'library'
}

export const CLICK_CHANNELS = [
  { id: 'click', name: 'Click' },
  { id: 'accent', name: 'Accent' },
  { id: 'q', name: '1/4' },
  { id: 'e', name: '1/8' },
  { id: 's', name: '1/16' },
] as const

export type ClickChannelId = (typeof CLICK_CHANNELS)[number]['id']

/**
 * Output routing for a channel: 'main' is outputs 1/2, `pair:N` is outputs 2N+1/2N+2,
 * and `mono:K` sends a mono sum to output K+1 alone.
 */
export type Bus = 'main' | `pair:${number}` | `mono:${number}`

export function parseBus(bus: string): { kind: 'pair' | 'mono'; index: number } {
  // Older saves used 'left' / 'right' for hard-panned routing on a stereo output.
  if (bus === 'left') return { kind: 'mono', index: 0 }
  if (bus === 'right') return { kind: 'mono', index: 1 }
  const m = /^(pair|mono):(\d+)$/.exec(bus)
  if (m) return { kind: m[1] as 'pair' | 'mono', index: Number(m[2]) }
  return { kind: 'pair', index: 0 }
}

export function normalizeBus(bus: string): Bus {
  const { kind, index } = parseBus(bus)
  return kind === 'pair' && index === 0 ? 'main' : `${kind}:${index}`
}

/** Highest output channel (0-based) a bus writes to. */
export function busTopChannel(bus: Bus): number {
  const { kind, index } = parseBus(bus)
  return kind === 'pair' ? index * 2 + 1 : index
}

export function busLabel(bus: Bus): string {
  const { kind, index } = parseBus(bus)
  if (kind === 'pair') return index === 0 ? 'Main 1/2' : `Out ${index * 2 + 1}/${index * 2 + 2}`
  return `Out ${index + 1} (mono)`
}

/** Every routing option a device with `outputs` channels supports, in menu order. */
export function busOptions(outputs: number): Bus[] {
  const out: Bus[] = ['main']
  for (let p = 1; p * 2 + 1 < outputs; p++) out.push(`pair:${p}`)
  for (let k = 0; k < outputs; k++) out.push(`mono:${k}`)
  return out
}

export interface ChannelSettings {
  volume: number
  mute: boolean
  solo: boolean
  bus: Bus
}

export const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

const SHARP_TO_FLAT: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' }

/** The key's root as one of KEYS (for the pad): "F#m" → "Gb", "Am" → "A". */
export function keyRoot(key: string): (typeof KEYS)[number] {
  const root = key.replace(/m(in(or)?)?$/i, '').trim()
  const flat = SHARP_TO_FLAT[root] ?? root
  return (KEYS as readonly string[]).includes(flat) ? (flat as (typeof KEYS)[number]) : 'C'
}

export function sectionEnd(song: Song, index: number): number {
  return index + 1 < song.sections.length ? song.sections[index + 1].start : song.duration
}

export function sectionIndexAt(song: Song, time: number): number {
  let idx = 0
  for (let i = 0; i < song.sections.length; i++) {
    if (song.sections[i].start <= time + 1e-6) idx = i
  }
  return idx
}

export function sectionColor(name: string): string {
  const n = name.toLowerCase()
  if (n.startsWith('count')) return '#6b7280'
  if (n.startsWith('intro')) return '#14b8a6'
  if (n.startsWith('verse')) return '#3b82f6'
  if (n.startsWith('pre')) return '#a855f7'
  if (n.startsWith('chorus')) return '#ef4444'
  if (n.startsWith('bridge')) return '#22c55e'
  if (n.startsWith('tag')) return '#eab308'
  if (n.startsWith('turn') || n.startsWith('inst')) return '#f97316'
  if (n.startsWith('outro') || n.startsWith('ending')) return '#0ea5e9'
  return '#94a3b8'
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

let idCounter = 0
export function uid(prefix = 'id'): string {
  idCounter++
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}
