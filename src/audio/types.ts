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
  album?: string
  /** When it was imported (ms since 1970), for the library's Recent list. */
  added?: number
  key: string
  bpm: number
  /** [beats per bar, beat unit] */
  timeSig: [number, number]
  /** Seconds at which bar 1, beat 1 of the click falls. */
  clickOffset: number
  duration: number
  /**
   * The sections in the current setlist: that setlist's own edit of them, or else the song's own
   * (`librarySections`). Edits in the song map change these, for that setlist only.
   */
  sections: Section[]
  /** The song's own sections (from import; saved with the song), before any setlist's edits. */
  librarySections?: Section[]
  /** Bytes of the files it was imported from (browser imports; a library song's are on disk). */
  bytes?: number
  /** The pad sound for this song (Song Settings); otherwise the Default Ambient Pad. */
  pad?: string
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
  // Spoken section cues (Settings ▸ Guide Cue Language), made by the desktop app.
  { id: 'cues', name: 'Cues' },
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
}

/** A stem that's the original recording, for reference (Settings ▸ Reference Track). */
export function isReferenceName(name: string): boolean {
  return /^(ref|reference|reference mix|ref mix|original|original mix|full mix)( \d+)?$/i.test(name.trim())
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

/** Section colours, after Playback's song map. */
export function sectionColor(name: string): string {
  const n = name.toLowerCase()
  if (n.startsWith('count')) return '#71717a'
  if (n.startsWith('intro')) return '#0d9488'
  if (n.startsWith('verse')) return '#6366f1'
  if (n.startsWith('pre')) return '#ca8a04'
  if (n.startsWith('chorus')) return '#ea580c'
  if (n.startsWith('bridge')) return '#db2777'
  // Playback colours a turnaround green, like a tag.
  if (n.startsWith('tag') || n.startsWith('turn')) return '#16a34a'
  if (n.startsWith('inst') || n.startsWith('interlude')) return '#0891b2'
  if (n.startsWith('outro') || n.startsWith('ending')) return '#7c3aed'
  return '#64748b'
}

/** Section types offered when adding one; the numbered ones count up (Verse 1, Verse 2…). */
export const SECTION_TYPES: { name: string; numbered: boolean }[] = [
  { name: 'Count In', numbered: false },
  { name: 'Intro', numbered: false },
  { name: 'Verse', numbered: true },
  { name: 'Pre-chorus', numbered: false },
  { name: 'Chorus', numbered: true },
  { name: 'Bridge', numbered: true },
  { name: 'Instrumental', numbered: false },
  { name: 'Turnaround', numbered: false },
  { name: 'Tag', numbered: false },
  { name: 'Outro', numbered: false },
  { name: 'Ending', numbered: false },
]

/** A new section's name: numbered types get the next number in this song ("Verse 3"). */
export function nextSectionName(type: { name: string; numbered: boolean }, sections: Section[]): string {
  if (!type.numbered) return type.name
  const re = new RegExp(`^${type.name}\\s*(\\d+)$`, 'i')
  const used = sections.map((s) => Number(re.exec(s.name.trim())?.[1] ?? 0))
  return `${type.name} ${Math.max(0, ...used) + 1}`
}

/** The badge on a section, as Playback abbreviates: Verse 1 → V1, Pre-chorus → Pc, Count In → Co, Tag → Ta. */
export function sectionAbbrev(name: string): string {
  const n = name.trim()
  // As Playback writes them: Co, I, Pc, Ta (turnaround)…
  const special: [RegExp, string][] = [
    [/^count/i, 'Co'],
    [/^intro$/i, 'I'],
    [/^pre[\s-]*chorus$/i, 'Pc'],
    [/^inst/i, 'It'],
    [/^interlude/i, 'Il'],
    [/^turn/i, 'Ta'],
    [/^tag$/i, 'Tg'],
  ]
  for (const [re, abbrev] of special) if (re.test(n)) return abbrev
  const num = /^(\S)\S*.*?\s*(\d+)$/.exec(n)
  if (num) return (num[1].toUpperCase() + num[2]).slice(0, 3)
  const parts = n.split('-').filter(Boolean)
  if (parts.length > 1) return parts[0][0].toUpperCase() + parts[1][0].toLowerCase()
  return n ? n[0].toUpperCase() + (n[1] ?? '').toLowerCase() : '?'
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
