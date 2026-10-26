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
}

export interface Song {
  id: string
  title: string
  key: string
  bpm: number
  /** [beats per bar, beat unit] */
  timeSig: [number, number]
  /** Seconds at which bar 1, beat 1 of the click falls. */
  clickOffset: number
  duration: number
  sections: Section[]
  /** Audio stems. Empty until the song is loaded (demo songs are rendered lazily). */
  stems: Stem[]
  artwork: string
  source: 'demo' | 'user'
}

export const CLICK_CHANNELS = [
  { id: 'click', name: 'Click' },
  { id: 'accent', name: 'Accent' },
  { id: 'q', name: '1/4' },
  { id: 'e', name: '1/8' },
  { id: 's', name: '1/16' },
] as const

export type ClickChannelId = (typeof CLICK_CHANNELS)[number]['id']

export type Bus = 'main' | 'left' | 'right'

export interface ChannelSettings {
  volume: number
  mute: boolean
  solo: boolean
  bus: Bus
}

export const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

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
