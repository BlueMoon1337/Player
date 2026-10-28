/**
 * Reads what a song needs from an Ableton Live set (.als, the session MultiTracks.com includes):
 * the tempo, its tempo changes, the time signature, and the locators, which MultiTracks uses to
 * mark the song's sections (Count In, Intro, Verse 1…). Takes the set's XML (the .als file is
 * that XML gzipped); positions come back in seconds.
 */

export interface AbletonSong {
  bpm: number | null
  timeSig: [number, number] | null
  /** Section markers, in order, in seconds from the start. */
  markers: { time: number; label: string }[]
  /** True when the set's tempo changes during the song. */
  tempoChanges: boolean
}

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

export function parseAbleton(xml: string): AbletonSong {
  const master = /<MasterTrack>([\s\S]*?)<\/MasterTrack>/.exec(xml)?.[1] ?? xml
  const tempoBlock = /<Tempo>([\s\S]*?)<\/Tempo>/.exec(master)?.[1] ?? ''
  const manual = Number(valueOf(tempoBlock, 'Manual'))
  const bpm = manual >= 20 && manual <= 999 ? Math.round(manual * 100) / 100 : null

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

  const locatorBlock = /<Locators>\s*<Locators>([\s\S]*?)<\/Locators>\s*<\/Locators>/.exec(xml)?.[1] ?? ''
  const markers = [...locatorBlock.matchAll(/<Locator\b[\s\S]*?<\/Locator>/g)]
    .map((m) => ({ beat: Number(valueOf(m[0], 'Time')), label: unescape(valueOf(m[0], 'Name') ?? '').trim() }))
    .filter((m) => Number.isFinite(m.beat) && m.beat >= 0)
    .sort((a, b) => a.beat - b.beat)
    .map((m, i) => ({ time: map.length ? beatsToSeconds(m.beat, map) : 0, label: m.label || `Marker ${i + 1}` }))

  return { bpm, timeSig, markers: map.length ? markers : [], tempoChanges }
}
