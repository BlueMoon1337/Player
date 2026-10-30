/**
 * Track and bus routing, after Playback's SmartRouting: every track goes to one of 16 buses by its
 * name (Settings ▸ Tracks), and each bus goes to an output of the audio device (Settings ▸ Buses).
 */
import { type Bus, isReferenceName, normalizeBus, parseBus } from './types'

export const BUSES = [
  { id: 'click', name: 'Click' },
  { id: 'guide', name: 'Guide' },
  { id: 'drums', name: 'Drums' },
  { id: 'percussion', name: 'Percussion', short: 'Perc' },
  { id: 'loops', name: 'Loops' },
  { id: 'bass', name: 'Bass' },
  { id: 'piano', name: 'Piano' },
  { id: 'keys', name: 'Keys' },
  { id: 'eg', name: 'Electric Guitars', short: 'EG' },
  { id: 'ag', name: 'Acoustic Guitars', short: 'AG' },
  { id: 'strings', name: 'Strings' },
  { id: 'horns', name: 'Horns' },
  // The pad player; no track goes to it.
  { id: 'pad', name: 'Pad' },
  { id: 'vocals', name: 'Vocals' },
  { id: 'fx', name: 'FX' },
  { id: 'aux', name: 'Aux' },
] as const

export type BusId = (typeof BUSES)[number]['id']

/** The buses a track can go to (not the pad's). */
export const TRACK_BUSES = BUSES.filter((b) => b.id !== 'pad')

export const isBus = (v: unknown): v is BusId => BUSES.some((b) => b.id === v)

/**
 * Playback's track names and where it routes them. "Name, 1-3" also lists Name 1, Name 2, Name 3.
 */
const DEFAULT_TRACKS = `
12 Strings: ag
Accordion, 1-2: aux
Acoustic Guitar, 1-3: ag
Acoustic Guitar Group: ag
Alto, 1-2: vocals
Arps, 1-2: keys
Aux Drums: percussion
Aux Drums (Live): percussion
Background Vocals, 1-6: vocals
Background Vocals FX, 1-4: fx
Bagpipes: aux
Band: aux
Banjo: aux
Banjo 1: ag
Banjo 2: aux
Bar Chimes: percussion
Baritone: vocals
Bass, 1-2: bass
Beatbox: loops
Bells: aux
Bongo: percussion
Bouzouki, 1-2: aux
Brass: horns
Brushes: percussion
Cajon: percussion
Cello, 1-3: strings
Chimes: aux
Choir, 1-3: vocals
Claps: loops
Clarinet, 1-3: aux
Clav: aux
Click Track: click
Congas: percussion
Cowbell: percussion
CP 70: keys
Crash Cymbals: percussion
Cuatro: ag
Daegeum: aux
Djembe: percussion
Dobro 1-3: aux
Double Bass, 1-3: strings
Drums, 1-2: drums
Drums (Live): drums
Dulcimer, 1-2: aux
EBow: aux
Electric Guitar, 1-12: eg
Electric Guitar Group, 1-2: eg
Electric Piano: piano
Fiddle: aux
Flute, 1-3: aux
French Horn, 1-3: horns
Full Score: aux
FX, 1-2: fx
Gayageum: click
Glockenspiel: aux
Guide (Dynamic): guide
Guide (Non-Dynamic): guide
Guiro: percussion
Guitars: eg
Guzheng, 1-2: aux
Harmonica: aux
Harmonium: aux
Harp: strings
Horns, 1-2: horns
Janggu: aux
Keys, 1-10: keys
Keys Group: keys
Kids: vocals
Lap Steel, 1-2: aux
Lead Sheet: aux
Lead Vocal, 1-3: vocals
Left: aux
Loop, 1-4: loops
Lyre: strings
Mandolin, 1-2: aux
Marimba: aux
Master: aux
MD: guide
MD Custom: guide
MD My Voice: guide
Mellotron: keys
Name Your Track: aux
Oboe: aux
Oohs, 1-3: vocals
Orchestra: strings
Organ, 1-2: keys
Original Song (Cloud Song): aux
Original Song (Reference): click
Perc (Live), 1-2: percussion
Percussion, 1-4: percussion
Piano, 1-3: piano
Piano FX: piano
Piri: aux
Rhodes: keys
Rhythm: aux
Right: aux
Rubab: aux
Saxophone, 1-3: horns
Sections: guide
Shaker: percussion
Sitar: aux
Sleigh Bells: percussion
Slide Guitar: eg
Snaps: loops
Soprano, 1-2: vocals
Spoken Word: aux
Steel Drums: percussion
Stereo Click + Tracks: aux
Stomps: percussion
Strings, 1-4: strings
Suspended Cymbals: percussion
Synth Bass, 1-2: bass
Synth Bells: keys
Synth FX: fx
Synth Group: keys
Synth Horns: keys
Synth Lead: keys
Synth Loop, 1-2: loops
Synth Pad: keys
Synth Strings: keys
Tambourine, 1-2: percussion
Tenor, 1-3: vocals
Theremin: keys
Timbales: percussion
Timpani: percussion
Toms: drums
Tracks: loops
Tremolo: aux
Trombone, 1-3: horns
Trumpet, 1-3: horns
Tuba, 1-3: horns
Turntables: loops
Ukulele, 1-2: aux
Upright Bass: bass
Vibes: aux
Viola, 1-3: strings
Violin, 1-3: strings
Vocal FX: fx
Vocal Loop: loops
Vocals: vocals
Vocoder: keys
VoxChop: fx
Whistle: aux
Woodwinds: aux
Wurli: keys
`

/**
 * KeyFinder's "Stems for Player" (github.com/BlueMoon1337/key-finder), where Playback doesn't name
 * them: Demucs' guitar and "other", the 2-stem split's accompaniment, the original mix kept for
 * reference (on the Click bus, as Playback's reference), and the song when it wasn't split.
 */
const KEYFINDER_TRACKS = `
Guitar: eg
Other: aux
Backing: aux
Reference: click
Song: aux
`

/** Every named track with its default bus. */
export const TRACK_DEFAULTS: { name: string; bus: BusId }[] = (() => {
  const out: { name: string; bus: BusId }[] = []
  for (const line of (DEFAULT_TRACKS + KEYFINDER_TRACKS).split('\n').filter((l) => l.trim())) {
    const [, names, bus] = /^(.*):\s*(\w+)$/.exec(line)!
    // "Name, 1-3": the name and its numbered ones; "Name 1-3": only the numbered ones.
    const m = /^(.*?)(,)?\s+(\d+)-(\d+)$/.exec(names)
    if (!m) {
      out.push({ name: names, bus: bus as BusId })
      continue
    }
    if (m[2]) out.push({ name: m[1], bus: bus as BusId })
    for (let n = Number(m[3]); n <= Number(m[4]); n++) out.push({ name: `${m[1]} ${n}`, bus: bus as BusId })
  }
  return out
})()

const DEFAULT_BY_NAME = new Map(TRACK_DEFAULTS.map((t) => [t.name.toLowerCase(), t.bus]))

const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

/** Names Playback doesn't list, by what they usually mean (MultiTracks' and others' shorthand). */
const GUESSES: [RegExp, BusId][] = [
  [/click/, 'click'],
  [/guide|\bcues?\b|^md\b/, 'guide'],
  [/\bfx\b|\bsfx\b|riser|sweep|impact/, 'fx'],
  [/\b(ag|ags|acoustic|ac gtr|nylon)\b/, 'ag'],
  [/\b(eg|egs|egtr|electric|e gtr|gtr|gtrs|guitar|guitars)\b/, 'eg'],
  [/\b(bgv|bgvs|bv|bvs|vox|vocal|vocals|voc|choir|harmony|harmonies|lead|lv|alto|tenor|soprano)\b/, 'vocals'],
  [/\b(bass|sub|808)\b/, 'bass'],
  [/\b(piano|pno|grand)\b/, 'piano'],
  [/\b(keys|key|kys|synth|synths|pad|pads|organ|rhodes|wurli|arp|arps|ep|b3)\b/, 'keys'],
  [/\b(loop|loops|lp|program|programming|prog|beat|beats|electronic|sequence|seq)\b/, 'loops'],
  [/\b(perc|percs|percussion|shaker|tamb|tambourine|conga|congas|bongo|bongos|cajon|timp|timpani|claps?)\b/, 'percussion'],
  [/\b(drum|drums|dr|kit|kick|kik|snare|snr|hat|hats|hh|hihat|tom|toms|oh|overheads?|cymbals?|room)\b/, 'drums'],
  [/\b(string|strings|str|violin|violins|viola|cello|celli|orch|orchestra)\b/, 'strings'],
  [/\b(horn|horns|brass|sax|trumpet|tpt|trombone|tbn|tuba)\b/, 'horns'],
]

/** The bus Playback would give a track by its name alone. */
export function defaultTrackBus(name: string): BusId {
  const k = key(name)
  const exact = DEFAULT_BY_NAME.get(k)
  if (exact) return exact
  // "Keys 11", "Drums (Studio)": as their plain name would go.
  const plain = k.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[\s_-]*\d+$/, '').trim()
  const known = DEFAULT_BY_NAME.get(plain)
  if (known) return known
  if (isReferenceName(name)) return DEFAULT_BY_NAME.get('original song (reference)')!
  const words = plain.replace(/[_\-.]+/g, ' ')
  return GUESSES.find(([re]) => re.test(words))?.[1] ?? 'aux'
}

/** Where a track goes: its own routing from Settings ▸ Tracks, else Playback's. */
export function trackBus(name: string, overrides: Record<string, string>): BusId {
  const k = key(name)
  for (const [n, bus] of Object.entries(overrides)) if (key(n) === k && isBus(bus)) return bus
  return defaultTrackBus(name)
}

/** A bus's name, as renamed in Settings ▸ Buses; `short` for a mixer strip ("EG", "Perc"). */
export function busName(id: string, names: Record<string, string>, short = false): string {
  const bus = BUSES.find((b) => b.id === id)
  return names[id]?.trim() || (short && bus && 'short' in bus ? bus.short : bus?.name) || id
}

/** The output a bus goes to; Main 1/2 unless routed in Settings ▸ Buses. */
export function busOutput(id: string, outputs: Record<string, string>): Bus {
  return outputs[id] ? normalizeBus(outputs[id]) : 'main'
}

/** Where Auto Pan sends a bus on a stereo output: the click and guide left (1), the rest right (2). */
export function autoPanOutput(id: string): Bus {
  return id === 'click' || id === 'guide' ? 'mono:0' : 'mono:1'
}

/** An output as Playback writes it: "1" for one output, "1/2" for a pair. */
export function outputLabel(bus: Bus): string {
  const { kind, index } = parseBus(bus)
  return kind === 'mono' ? `${index + 1}` : `${index * 2 + 1}/${index * 2 + 2}`
}
