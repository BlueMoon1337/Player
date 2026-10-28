/**
 * Reads what a song needs from an Ableton Live set (.als, the session MultiTracks.com includes):
 * the tempo, its tempo changes, the time signature, and the song's sections (Count In, Intro,
 * Verse 1…). Sections come from the set's locators, or, in a set without any, from arrangement
 * clips named like sections (a "Cues" or guide track cut up per section). Takes the set's XML
 * (the .als file is that XML gzipped); positions come back in seconds. Handles Live 9 to 12
 * (Live 12 calls the master track the main track).
 */

export interface AbletonSong {
  bpm: number | null
  timeSig: [number, number] | null
  /** Section markers, in order, in seconds from the start. */
  markers: { time: number; label: string }[]
  /** True when the set's tempo changes during the song. */
  tempoChanges: boolean
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

/** `fallbackBpm` (e.g. from the download's name) is used when the set's own tempo can't be read. */
export function parseAbleton(xml: string, fallbackBpm?: number | null): AbletonSong {
  // Every track's mixer has a Tempo; only the master's (Live 12: main) is the song's.
  const master = /<(MasterTrack|MainTrack)\b[^>]*>([\s\S]*?)<\/\1>/.exec(xml)?.[2] ?? ''
  const tempoBlock = /<Tempo>([\s\S]*?)<\/Tempo>/.exec(master)?.[1] ?? ''
  const manual = Number(valueOf(tempoBlock, 'Manual'))
  const bpm = manual >= 20 && manual <= 999 ? Math.round(manual * 100) / 100 : (fallbackBpm ?? null)

  // Tempo automation: the master track envelope whose target is the tempo's automation target.
  const targetId = /<AutomationTarget\s+Id="(\d+)"/.exec(tempoBlock)?.[1]
  let map: TempoPoint[] = bpm ? [{ beat: 0, bpm }] : []
  if (targetId) {
    const envelopes = master.split('<AutomationEnvelope ').slice(1)
    const env = envelopes.find((e) => new RegExp(`<PointeeId\\s+Value="${targetId}"`).test(e))
    if (env) {
      const points = [...env.matchAll(/<FloatEvent[^>]*\bTime="([-\d.eE+]+)"[^>]*\bValue="([-\d.eE+]+)"/g)]
        .map((m) => ({ beat: Math.max(0, Number(m[1])), bpm: Number(m[2]) }))
        .filter((p) => p.bpm >= 20 && p.bpm <= 999)
        .sort((a, b) => a.beat - b.beat)
      if (points.length) map = points[0].beat > 0 ? [{ beat: 0, bpm: points[0].bpm }, ...points] : points
    }
  }
  const tempoChanges = new Set(map.map((p) => p.bpm)).size > 1

  // Live encodes the time signature as (numerator - 1) + 99 × log2(denominator).
  const tsCode = Number(valueOf(/<TimeSignature>([\s\S]*?)<\/TimeSignature>/.exec(master)?.[1] ?? '', 'Manual'))
  let timeSig: [number, number] | null = null
  if (Number.isFinite(tsCode) && tsCode > 0) {
    const num = (tsCode % 99) + 1
    const den = 2 ** Math.floor(tsCode / 99)
    if (num >= 1 && num <= 32 && [2, 4, 8, 16].includes(den)) timeSig = [num, den]
  }

  // Locators, wherever the set keeps them.
  let found = [...xml.matchAll(/<Locator\s+Id="[^"]*"\s*>([\s\S]*?)<\/Locator>/g)].map((m) => ({
    beat: Number(valueOf(m[1], 'Time')),
    label: unescape(valueOf(m[1], 'Name') ?? '').trim(),
  }))
  let markerSource: AbletonSong['markerSource'] = 'locators'
  if (!found.length) {
    // No locators: arrangement clips named like sections, on any track (once per start time).
    markerSource = 'clips'
    const byBeat = new Map<number, string>()
    for (const m of xml.matchAll(/<(AudioClip|MidiClip)\s+Id="\d+"\s+Time="([-\d.eE+]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
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
  return { bpm, timeSig, markers: usable, tempoChanges, markerSource: usable.length ? markerSource : null }
}
