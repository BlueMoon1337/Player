/**
 * Cut sections: a section can be cut from a setlist's arrangement (Section ▸ Cut), and its music
 * is then left out — a 12-minute song with a 4-minute section cut plays for 8 minutes.
 *
 * Nothing is copied or deleted: the engine plays the song's own audio and, as playback reaches a
 * cut, carries on from the end of it at the same instant (as a section jump does). So there are
 * two clocks: the song's own time, which the audio, sections, click and tempo map are in, and the
 * time as heard, without the cuts, which the timeline, the time display and the section list show.
 *
 * A section can also have a Fade Out: the song fades out over a few seconds ending at the end of
 * that section, and stops there. The sections after it stay on the timeline (dimmed); playing
 * from one of them plays on to the real end.
 */
import type { Section, Song } from './types'
import { sectionEnd } from './types'

/** A stretch of the song's own time that's left out. */
export interface Cut {
  start: number
  end: number
}

type Arranged = Pick<Song, 'sections' | 'duration'>

/** The cuts in order, back-to-back cut sections joined into one. */
export function cuts(song: Arranged): Cut[] {
  const out: Cut[] = []
  song.sections.forEach((s, i) => {
    if (!s.skip) return
    const end = sectionEnd(song as Song, i)
    const last = out[out.length - 1]
    if (last && Math.abs(last.end - s.start) < 1e-6) last.end = end
    else out.push({ start: s.start, end })
  })
  return out
}

export const hasCuts = (song: Arranged) => song.sections.some((s) => s.skip)

/** How long the whole song is, as heard (the cuts left out; the timeline's length). */
export function heardLength(song: Arranged): number {
  return cuts(song).reduce((t, c) => t - (c.end - c.start), song.duration)
}

/** How long the song plays for, as arranged: without the cuts, and up to its fade-out's end. */
export function playedLength(song: Arranged): number {
  return toHeard(song, songEnd(song))
}

/** The song's own time → the time as heard. A time inside a cut is where the cut is heard (its join). */
export function toHeard(song: Arranged, t: number): number {
  let out = t
  for (const c of cuts(song)) {
    if (t >= c.end) out -= c.end - c.start
    else if (t > c.start) out -= t - c.start
  }
  return out
}

/** The time as heard → the song's own time (the far side of a join). */
export function toSong(song: Arranged, heard: number): number {
  let t = heard
  for (const c of cuts(song)) if (t >= c.start - 1e-6) t += c.end - c.start
  return Math.min(t, song.duration)
}

/** Where a time inside a cut plays from instead: the end of the cut (or null when it isn't in one). */
export function pastCut(song: Arranged, t: number): number | null {
  for (const c of cuts(song)) if (t >= c.start - 1e-4 && t < c.end - 1e-4) return c.end
  return null
}

/** The next cut that starts after `t`, if any. */
export function nextCut(song: Arranged, t: number): Cut | null {
  return cuts(song).find((c) => c.start > t + 1e-4) ?? null
}

/** Where the music runs out, in the song's own time: the start of a cut that runs to the end, else its end. */
export function fullEnd(song: Arranged): number {
  const last = cuts(song).at(-1)
  return last && last.end >= song.duration - 1e-3 ? last.start : song.duration
}

/** Where the song stops, as arranged: its fade-out's end, else where the music runs out. */
export function songEnd(song: Arranged): number {
  const f = fadeOut(song)
  return f ? Math.min(f.end, fullEnd(song)) : fullEnd(song)
}

/** The longest and shortest fade a section can be given, in seconds. */
export const FADE_MIN = 1
export const FADE_MAX = 60
/** A new fade's length. */
export const FADE_DEFAULT = 8

/** A section's fade-out: where it starts and ends (the song's own time) and how long it's heard for. */
export interface FadeOut {
  section: Section
  index: number
  start: number
  end: number
  length: number
}

/** The song's fade-out, if a section has one: it ends at the end of the first such section that plays. */
export function fadeOut(song: Arranged): FadeOut | null {
  const index = song.sections.findIndex((s) => !s.skip && (s.fadeOut ?? 0) > 0)
  if (index < 0) return null
  const section = song.sections[index]
  const end = sectionEnd(song as Song, index)
  const heardEnd = toHeard(song, end)
  const length = Math.max(0, Math.min(section.fadeOut!, heardEnd))
  if (length <= 0) return null
  // As heard: a fade that reaches back over a cut takes that much longer in the song's own time.
  let start = toSong(song, heardEnd - length)
  if (start > end) start = end
  return { section, index, start, end, length }
}

/** The sections that play, with where each starts and ends as heard. */
export function heardSections(song: Arranged): { section: Section; index: number; start: number; end: number }[] {
  return song.sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => !section.skip)
    .map(({ section, index }) => ({
      section,
      index,
      start: toHeard(song, section.start),
      end: toHeard(song, sectionEnd(song as Song, index)),
    }))
}

/** The joins, as heard, with the sections cut there (for the song map's ✂ marks). */
export function joins(song: Arranged): { at: number; sections: Section[]; length: number }[] {
  return cuts(song).map((c) => ({
    at: toHeard(song, c.start),
    sections: song.sections.filter((s) => s.skip && s.start >= c.start - 1e-6 && s.start < c.end - 1e-6),
    length: c.end - c.start,
  }))
}
