/**
 * A song's beats and bars, following its tempo changes and time signature changes (Song Settings ▸
 * Tempo Changes and Time Changes, as MultiTracks.com lists them). The generated click, the
 * waveform grid, jumps at the next bar, pre-roll and spoken cues all count from here.
 *
 * A change takes effect on the beat nearest its start time, so a change typed in a few
 * milliseconds off still lands on the beat, and the beats stay continuous through it.
 */
import type { Song } from './types'

export interface TempoChange {
  /** Seconds from the start of the song. */
  start: number
  /** Beats per minute, in beats of the time signature's beat unit. */
  bpm: number
}

export interface MeterChange {
  start: number
  timeSig: [number, number]
}

export interface Beat {
  time: number
  /** The bar it's in: 0 is the bar starting at the click offset (bar 1); pickups are negative. */
  bar: number
  /** Its place in the bar, 0 for the downbeat. */
  index: number
  beatsInBar: number
  /** Seconds to the next beat. */
  length: number
}

type Timed = Pick<Song, 'bpm' | 'timeSig' | 'clickOffset' | 'duration' | 'tempos' | 'meters'>

/** The song's tempo changes, the first at the start; a song without any keeps its one BPM. */
export function tempoMap(song: Pick<Song, 'bpm' | 'tempos'>): TempoChange[] {
  const list = (song.tempos ?? []).filter((t) => t.bpm >= 10 && t.bpm <= 999 && t.start >= 0).sort((a, b) => a.start - b.start)
  if (!list.length) return [{ start: 0, bpm: song.bpm }]
  // The first tempo is the song's from the start.
  return [{ ...list[0], start: 0 }, ...list.slice(1)]
}

export function meterMap(song: Pick<Song, 'timeSig' | 'meters'>): MeterChange[] {
  const list = (song.meters ?? []).filter((m) => m.timeSig[0] >= 1 && m.timeSig[0] <= 32 && m.start >= 0).sort((a, b) => a.start - b.start)
  if (!list.length) return [{ start: 0, timeSig: song.timeSig }]
  return [{ ...list[0], start: 0 }, ...list.slice(1)]
}

/** Whether the song changes tempo or time signature anywhere. */
export function hasChanges(song: Pick<Song, 'bpm' | 'timeSig' | 'tempos' | 'meters'>): boolean {
  return new Set(tempoMap(song).map((t) => t.bpm)).size > 1 || new Set(meterMap(song).map((m) => m.timeSig.join('/'))).size > 1
}

const at = <T extends { start: number }>(list: T[], t: number): T => {
  let found = list[0]
  for (const x of list) if (x.start <= t + 1e-6) found = x
  return found
}

export const bpmAt = (song: Pick<Song, 'bpm' | 'tempos'>, t: number) => at(tempoMap(song), t).bpm
export const timeSigAt = (song: Pick<Song, 'timeSig' | 'meters'>, t: number) => at(meterMap(song), t).timeSig

const cache = new WeakMap<object, { key: string; beats: Beat[] }>()

/** Every beat of the song, pickups before the click offset included. */
export function beatGrid(song: Timed): Beat[] {
  const tempos = tempoMap(song)
  const meters = meterMap(song)
  const key = JSON.stringify([tempos, meters, song.clickOffset, song.duration])
  const hit = cache.get(song)
  if (hit?.key === key) return hit.beats

  const beats: Beat[] = []
  // Pickups: back from the click offset at the opening tempo and time signature.
  const firstLen = 60 / at(tempos, song.clickOffset).bpm
  const firstNum = at(meters, song.clickOffset).timeSig[0]
  const pickups: Beat[] = []
  for (let k = 1; song.clickOffset - k * firstLen > -1e-6; k++) {
    const index = (((-k % firstNum) + firstNum) % firstNum) as number
    pickups.unshift({ time: song.clickOffset - k * firstLen, bar: Math.floor(-k / firstNum), index, beatsInBar: firstNum, length: firstLen })
  }
  beats.push(...pickups)

  let t = song.clickOffset
  let bar = 0
  let index = 0
  let ti = tempos.findIndex((x) => x === at(tempos, t))
  let mi = meters.findIndex((x) => x === at(meters, t))
  let num = meters[mi].timeSig[0]
  let len = 60 / tempos[ti].bpm
  for (let guard = 0; t < song.duration && guard < 200000; guard++) {
    // A time signature change on (the beat nearest) this beat starts a new bar here.
    while (mi + 1 < meters.length && meters[mi + 1].start <= t + len / 2) {
      mi++
      num = meters[mi].timeSig[0]
      if (index !== 0) {
        bar++
        index = 0
      }
    }
    // A tempo change on this beat sets the length of the beats from here.
    while (ti + 1 < tempos.length && tempos[ti + 1].start <= t + len / 2) {
      ti++
      len = 60 / tempos[ti].bpm
    }
    let next = t + len
    // A tempo change nearer the next beat than this one lands exactly on it.
    const coming = tempos[ti + 1]
    if (coming && coming.start < next + len / 2 && coming.start > t + len / 2) next = coming.start
    beats.push({ time: t, bar, index, beatsInBar: num, length: next - t })
    index++
    if (index >= num) {
      index = 0
      bar++
    }
    t = next
  }
  cache.set(song, { key, beats })
  return beats
}

/** Every bar line (downbeat) in the song. */
export function barLines(song: Timed): number[] {
  return beatGrid(song)
    .filter((b) => b.index === 0)
    .map((b) => b.time)
}

/** The beat playing at `t` (the last one at or before it), or null before the first. */
export function beatAt(song: Timed, t: number): Beat | null {
  const beats = beatGrid(song)
  let lo = 0
  let hi = beats.length - 1
  if (hi < 0 || beats[0].time > t) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (beats[mid].time <= t + 1e-6) lo = mid
    else hi = mid - 1
  }
  return beats[lo]
}

/** The bar line nearest `t` (for snapping section edits). */
export function nearestBar(song: Timed, t: number): number {
  let best = 0
  for (const b of barLines(song)) if (Math.abs(b - t) < Math.abs(best - t)) best = b
  return best
}

/** The first bar line after `t` (a jump at the next bar); the song's end if there's none. */
export function nextBar(song: Timed, t: number): number {
  return barLines(song).find((b) => b > t) ?? song.duration
}

/** The bar line one bar before `t`: where a count-in to a section starting at `t` begins. */
export function barBefore(song: Timed, t: number): number {
  const lines = barLines(song).filter((b) => b < t - 0.02)
  if (lines.length) return lines[lines.length - 1]
  return t - (60 / bpmAt(song, t)) * timeSigAt(song, t)[0]
}

/** The beats in the bar before `t` (for counting into a section). */
export function beatsBefore(song: Timed, t: number): Beat[] {
  const from = barBefore(song, t)
  return beatGrid(song).filter((b) => b.time >= from - 0.01 && b.time < t - 0.01)
}
