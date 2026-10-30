/**
 * Reads what a song needs from an Ableton Live set (.als, the session MultiTracks.com includes):
 * the tempo, its tempo changes, the time signature, and the song's sections (Count In, Intro,
 * Verse 1…). Sections come from the set's locators, or, in a set without any, from arrangement
 * clips named like sections (a "Cues" or guide track cut up per section). Takes the set's XML
 * (the .als file is that XML gzipped); positions come back in seconds. Handles Live 9 to 12
 * (Live 12 calls the master track the main track), and sets as old as Live 8.
 */

export interface AbletonSong {
  bpm: number | null
  timeSig: [number, number] | null
  /** Section markers, in order, in seconds from the start. */
  markers: { time: number; label: string }[]
  /** True when the set's tempo changes during the song. */
  tempoChanges: boolean
  /** The tempo changes in seconds (a ramp becomes a change on each beat); the first at 0. */
  tempos: { start: number; bpm: number }[]
  /** Time signature changes (the set's time signature automation), in seconds; empty if none. */
  meters: { start: number; timeSig: [number, number] }[]
  /** Where the sections came from, or null when the set has none. */
  markerSource: 'locators' | 'clips' | null
}

/** Clip names that are section names: English (as MultiTracks labels them) and Spanish. */
const SECTION_NAME =
  /^(count[\s-]*(in|off)|intro|verse|pre[\s-]*chorus|chorus|post[\s-]*chorus|bridge|tag|outro|ending|end|interlude|instrumental|inst|turn(around)?|vamp|refrain|break(down)?|solo|hook|channel|exhortation|spontaneous|verso|pre[\s-]*coro|coro|puente|final|interludio|estrofa)\b/i

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

const valueOf = (xml: string, tag: string) => new RegExp(`<${tag}\\s+Value="([^"]*)"`).exec(xml)?.[1]

/** A tempo map: breakpoints in beats, with linear ramps between them (as Live draws automation). */
type TempoPoint = { beat: number; bpm: number }

/** Seconds at a given beat, integrating 60 / tempo over the (piecewise-linear) tempo map. */
export function beatsToSeconds(beat: number, map: TempoPoint[]): number {
  if (!map.length) return 0
  let t = 0
  let prev: TempoPoint = { beat: 0, bpm: map[0].bpm }
  for (const pt of map) {
    if (pt.beat <= prev.beat) {
      prev = { beat: prev.beat, bpm: pt.bpm }
      continue
    }
    const end = Math.min(beat, pt.beat)
    if (end > prev.beat) {
      const span = pt.beat - prev.beat
      const k = (pt.bpm - prev.bpm) / span // tempo change per beat
      const endBpm = prev.bpm + k * (end - prev.beat)
      t += Math.abs(k) < 1e-9 ? ((end - prev.beat) * 60) / prev.bpm : (60 / k) * Math.log(endBpm / prev.bpm)
    }
    if (beat <= pt.beat) return t
    prev = pt
  }
  return t + ((beat - prev.beat) * 60) / prev.bpm
}

/** The tempo map as changes from one tempo to the next, for Player's Tempo Changes. */
function tempoSteps(map: TempoPoint[]): { start: number; bpm: number }[] {
  const out: { start: number; bpm: number }[] = []
  const push = (beat: number, bpm: number) => {
    const start = Math.round(beatsToSeconds(beat, map) * 1000) / 1000
    const value = Math.round(bpm * 100) / 100
    const last = out[out.length - 1]
    if (last && Math.abs(last.start - start) < 0.001) last.bpm = value
    else if (!last || Math.abs(last.bpm - value) >= 0.005) out.push({ start, bpm: value })
  }
  if (!map.length) return out
  push(0, map[0].bpm)
  for (let i = 1; i < map.length; i++) {
    const a = map[i - 1]
    const b = map[i]
    if (b.beat - a.beat < 1e-6) {
      push(b.beat, b.bpm)
      continue
    }
    if (Math.abs(b.bpm - a.bpm) < 1e-6) continue
    // A ramp: a change on each beat, at the tempo halfway through that beat.
    for (let beat = Math.ceil(a.beat - 1e-6); beat < b.beat - 1e-6; beat++) {
      const mid = Math.min(b.beat, beat + 0.5)
      push(beat, a.bpm + ((b.bpm - a.bpm) * (mid - a.beat)) / (b.beat - a.beat))
    }
    push(b.beat, b.bpm)
  }
  return out
}

/** Live's time signature code: (numerator - 1) + 99 × log2(denominator). */
function decodeTimeSig(code: number): [number, number] | null {
  if (!Number.isFinite(code) || code < 0) return null
  const num = (code % 99) + 1
  const den = 2 ** Math.floor(code / 99)
  return num >= 1 && num <= 32 && [2, 4, 8, 16].includes(den) ? [num, den] : null
}

/** `fallbackBpm` (e.g. from the download's name) is used when the set's own tempo can't be read. */
/** Tempo breakpoints in an automation's events; the event at the far-negative time is the start value. */
function tempoPoints(xml: string): TempoPoint[] {
  return [...xml.matchAll(/<FloatEvent[^>]*\bTime="([-\d.eE+]+)"[^>]*\bValue="([-\d.eE+]+)"/g)]
    .map((m) => ({ beat: Math.max(0, Number(m[1])), bpm: Number(m[2]) }))
    .filter((p) => p.bpm >= 20 && p.bpm <= 999)
    .sort((a, b) => a.beat - b.beat)
}

export function parseAbleton(xml: string, fallbackBpm?: number | null): AbletonSong {
  // Every track's mixer has a Tempo; only the master's (Live 12: main) is the song's.
  const master = /<(MasterTrack|MainTrack)\b[^>]*>([\s\S]*?)<\/\1>/.exec(xml)?.[2] ?? ''
  const tempoBlock = /<Tempo>([\s\S]*?)<\/Tempo>/.exec(master)?.[1] ?? ''
  // Live 8 has no Manual value: the tempo, and any changes, are events inside the Tempo itself.
  const inline = tempoPoints(tempoBlock)
  const manual = Number(valueOf(tempoBlock, 'Manual'))
  const setBpm = manual >= 20 && manual <= 999 ? manual : (inline[0]?.bpm ?? null)
  const bpm = setBpm !== null ? Math.round(setBpm * 100) / 100 : (fallbackBpm ?? null)

  // Tempo automation (Live 9+): the master track envelope whose target is the tempo's automation target.
  const targetId = /<AutomationTarget\s+Id="(\d+)"/.exec(tempoBlock)?.[1]
  let map: TempoPoint[] = bpm ? [{ beat: 0, bpm }] : []
  const env = targetId
    ? master.split('<AutomationEnvelope ').slice(1).find((e) => new RegExp(`<PointeeId\\s+Value="${targetId}"`).test(e))
    : undefined
  const points = env ? tempoPoints(env) : inline
  if (points.length) map = points[0].beat > 0 ? [{ beat: 0, bpm: points[0].bpm }, ...points] : points
  const tempoChanges = new Set(map.map((p) => p.bpm)).size > 1

  // Live encodes the time signature as (numerator - 1) + 99 × log2(denominator); Live 8 as an event.
  const tsBlock = /<TimeSignature>([\s\S]*?)<\/TimeSignature>/.exec(master)?.[1] ?? ''
  const tsCode = Number(valueOf(tsBlock, 'Manual') ?? /<EnumEvent[^>]*\bValue="(\d+)"/.exec(tsBlock)?.[1])
  let timeSig = tsCode > 0 ? decodeTimeSig(tsCode) : null
  // Time signature changes: the master track envelope on the time signature's automation target.
  const tsTarget = /<AutomationTarget\s+Id="(\d+)"/.exec(tsBlock)?.[1]
  const tsEnv = tsTarget
    ? master.split('<AutomationEnvelope ').slice(1).find((e) => new RegExp(`<PointeeId\\s+Value="${tsTarget}"`).test(e))
    : undefined
  const meters: AbletonSong['meters'] = []
  if (tsEnv && map.length) {
    const events = [...tsEnv.matchAll(/<EnumEvent[^>]*\bTime="([-\d.eE+]+)"[^>]*\bValue="(\d+)"/g)]
      .map((m) => ({ beat: Math.max(0, Number(m[1])), sig: decodeTimeSig(Number(m[2])) }))
      .filter((e): e is { beat: number; sig: [number, number] } => !!e.sig)
      .sort((a, b) => a.beat - b.beat)
    for (const e of events) {
      const start = Math.round(beatsToSeconds(e.beat, map) * 1000) / 1000
      const last = meters[meters.length - 1]
      if (last && Math.abs(last.start - start) < 0.001) last.timeSig = e.sig
      else if (!last || last.timeSig.join('/') !== e.sig.join('/')) meters.push({ start, timeSig: e.sig })
    }
    if (meters.length) timeSig = meters[0].timeSig
  }

  // Locators, wherever the set keeps them (Live 8 writes them without an Id).
  let found = [...xml.matchAll(/<Locator(?:\s[^>]*)?>([\s\S]*?)<\/Locator>/g)].map((m) => ({
    beat: Number(valueOf(m[1], 'Time')),
    label: unescape(valueOf(m[1], 'Name') ?? '').trim(),
  }))
  let markerSource: AbletonSong['markerSource'] = 'locators'
  if (!found.length) {
    // No locators: arrangement clips named like sections, on any track (once per start time).
    markerSource = 'clips'
    const byBeat = new Map<number, string>()
    for (const m of xml.matchAll(/<(AudioClip|MidiClip)\b[^>]*\bTime="([-\d.eE+]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
      const name = unescape(valueOf(m[3], 'Name') ?? '').trim()
      const beat = Number(m[2])
      if (SECTION_NAME.test(name) && Number.isFinite(beat) && !byBeat.has(beat)) byBeat.set(beat, name)
    }
    found = [...byBeat].map(([beat, label]) => ({ beat, label }))
  }
  const markers = found
    .filter((m) => Number.isFinite(m.beat) && m.beat >= 0)
    .sort((a, b) => a.beat - b.beat)
    .map((m, i) => ({ time: map.length ? beatsToSeconds(m.beat, map) : 0, label: m.label || `Marker ${i + 1}` }))

  const usable = map.length ? markers : []
  return {
    bpm,
    timeSig,
    markers: usable,
    tempoChanges,
    tempos: tempoSteps(map),
    meters: meters.length > 1 ? meters : [],
    markerSource: usable.length ? markerSource : null,
  }
}
