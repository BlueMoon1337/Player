/**
 * Reads a song's tempo changes and time signature changes from its click stem (a MultiTracks
 * "Click Track", KeyFinder's click on the song's own beats): each click is a beat, the space
 * between clicks is the tempo, and the accented clicks are the downbeats, so the number of
 * clicks from one accent to the next is the bar's length. The first accent is bar 1.
 */
import type { MeterChange, TempoChange } from './grid'

export interface ClickMap {
  /** Seconds to the first downbeat (bar 1, beat 1); the first click when no accents are heard. */
  offset: number
  tempos: TempoChange[]
  /** Bars as counted from the accents; empty when the click has none. */
  meters: MeterChange[]
  clicks: number
}

interface Click {
  time: number
  freq: number
  amp: number
}

/** Each click: where it starts, how high it is (zero crossings) and how loud. */
function findClicks(data: Float32Array, sr: number): Click[] {
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  if (peak < 1e-3) return []
  const threshold = peak * 0.2
  const quiet = Math.round(sr * 0.07) // no two clicks closer than 70 ms (an 850 BPM ceiling)
  const win = Math.round(sr * 0.012)
  const clicks: Click[] = []
  let last = -quiet
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) < threshold || i - last < quiet) continue
    last = i
    let crossings = 0
    let amp = 0
    const end = Math.min(data.length - 1, i + win)
    for (let k = i; k < end; k++) {
      amp = Math.max(amp, Math.abs(data[k]))
      if (data[k] >= 0 !== data[k + 1] >= 0) crossings++
    }
    clicks.push({ time: i / sr, freq: (crossings / 2) * (sr / (end - i || 1)), amp })
  }
  return clicks
}

/** The accented clicks, if the click has two kinds: the fewer of two pitches (or levels) that stand apart. */
function accents(clicks: Click[]): boolean[] | null {
  for (const feature of ['freq', 'amp'] as const) {
    const values = clicks.map((c) => c[feature])
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    if (hi <= 0 || (hi - lo) / hi < 0.12) continue
    // Two groups split at the widest gap between sorted values.
    const sorted = [...values].sort((a, b) => a - b)
    let cut = 0
    let widest = 0
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > widest) {
        widest = sorted[i] - sorted[i - 1]
        cut = (sorted[i] + sorted[i - 1]) / 2
      }
    }
    if (widest / hi < 0.08) continue
    const high = values.map((v) => v > cut)
    const highCount = high.filter(Boolean).length
    const accentHigh = highCount <= clicks.length - highCount
    const marks = accentHigh ? high : high.map((h) => !h)
    const count = marks.filter(Boolean).length
    // Accents are one in two to one in sixteen clicks.
    if (count >= 2 && count <= clicks.length / 2) return marks
  }
  return null
}

const roundBpm = (bpm: number) => {
  const r = Math.round(bpm * 100) / 100
  return Math.abs(r - Math.round(r)) < 0.06 ? Math.round(r) : r
}

/** Steady stretches of the click, as tempo changes: a new tempo where two clicks in a row leave the old one. */
function tempoChanges(times: number[]): TempoChange[] | null {
  const gaps = times.slice(1).map((t, i) => t - times[i])
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const typical = sortedGaps[Math.floor(sortedGaps.length / 2)]
  if (!(typical > 0.12 && typical < 2.5)) return null
  const segments: { from: number; to: number }[] = [] // click indexes
  let from = 0
  let ref = gaps[0]
  for (let i = 1; i < gaps.length; i++) {
    const off = (g: number) => Math.abs(g - ref) / ref > 0.025
    // A stop in the click (a gap of two beats or more) carries on at the same tempo after it.
    if (gaps[i] > ref * 1.8) {
      segments.push({ from, to: i })
      from = i + 1
      ref = gaps[i + 1] ?? ref
      i++
      continue
    }
    if (off(gaps[i]) && (i + 1 >= gaps.length || off(gaps[i + 1]))) {
      segments.push({ from, to: i })
      from = i
      ref = gaps[i]
      continue
    }
    // Follow slow drift: the reference is the average of the stretch so far.
    ref = (times[i + 1] - times[from]) / (i + 1 - from)
  }
  segments.push({ from, to: gaps.length })
  const out: TempoChange[] = []
  for (const s of segments) {
    const beats = s.to - s.from
    if (beats < 1) continue
    const bpm = roundBpm((60 * beats) / (times[s.to] - times[s.from]))
    const last = out[out.length - 1]
    if (last && Math.abs(last.bpm - bpm) / bpm < 0.005) continue
    out.push({ start: Math.round(times[s.from] * 1000) / 1000, bpm })
  }
  if (!out.length || out.length > gaps.length / 2 + 1) return null
  out[0] = { ...out[0], start: 0 }
  return out
}

/** The tempo map a click stem plays, or null when it doesn't sound like a click. */
export function detectClickMap(data: Float32Array, sampleRate: number, beatUnit = 4): ClickMap | null {
  const clicks = findClicks(data, sampleRate)
  if (clicks.length < 8) return null
  const times = clicks.map((c) => c.time)
  const tempos = tempoChanges(times)
  if (!tempos) return null
  const marks = accents(clicks)
  const meters: MeterChange[] = []
  let offset = times[0]
  if (marks) {
    const downbeats = clicks.map((_, i) => i).filter((i) => marks[i])
    offset = times[downbeats[0]]
    for (let k = 0; k + 1 < downbeats.length; k++) {
      const n = downbeats[k + 1] - downbeats[k]
      if (n < 1 || n > 32) continue
      const start = Math.round(times[downbeats[k]] * 1000) / 1000
      if (!meters.length || meters[meters.length - 1].timeSig[0] !== n) meters.push({ start, timeSig: [n, beatUnit] })
    }
    if (meters.length) meters[0] = { ...meters[0], start: 0 }
  }
  return { offset: Math.round(offset * 1000) / 1000, tempos, meters, clicks: clicks.length }
}

/** A click stem's samples, mixed to one channel. */
export function clickSamples(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)
  const a = buffer.getChannelData(0)
  const b = buffer.getChannelData(1)
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2
  return out
}

/**
 * What the song takes from a click map. With a tempo known from elsewhere (a MultiTracks name),
 * a click that counts in eighths (twice that) or halves is counted in the song's beats; a click
 * at some other speed keeps only its bar 1.
 */
export function songTiming(
  map: ClickMap,
  knownBpm: number | null,
): { clickOffset: number; bpm?: number; timeSig?: [number, number]; tempos?: TempoChange[]; meters?: MeterChange[] } {
  let tempos = map.tempos
  let meters = map.meters
  if (knownBpm) {
    const main = [...tempos].sort((a, b) => a.bpm - b.bpm)[Math.floor(tempos.length / 2)].bpm
    const ratio = main / knownBpm
    const scale = [1, 2, 0.5].find((r) => Math.abs(ratio / r - 1) < 0.03)
    if (!scale) return { clickOffset: map.offset }
    if (scale !== 1) {
      tempos = tempos.map((t) => ({ start: t.start, bpm: roundBpm(t.bpm / scale) }))
      meters = meters
        .map((m) => ({ start: m.start, timeSig: [m.timeSig[0] / scale, m.timeSig[1]] as [number, number] }))
        .filter((m) => Number.isInteger(m.timeSig[0]) && m.timeSig[0] >= 1)
    }
    // A steady click at the known tempo: the known (exact) BPM, no changes.
    if (tempos.length === 1) tempos = [{ start: 0, bpm: knownBpm }]
  }
  return {
    clickOffset: map.offset,
    bpm: tempos[0].bpm,
    timeSig: meters[0]?.timeSig,
    tempos: tempos.length > 1 ? tempos : undefined,
    meters: meters.length > 1 ? meters : undefined,
  }
}
