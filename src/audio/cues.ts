/**
 * Spoken section cues, as Playback gives them: the section's name a bar before it starts, and with
 * Count Into Each Section, the rest of that bar counted ("Chorus, two, three, four"). The words are
 * spoken by the desktop app (electron/cues.ts); this lays them out in time for a song.
 */
import type { CueLanguage } from '../settings'
import { toHeard, toSong } from './arrangement'
import { barBefore, beatsBefore, meterMap } from './grid'
import type { Song } from './types'

type Lang = Exclude<CueLanguage, 'off'>

/** Section words in each language, by the section's kind; the number (Verse 2) is kept. */
const SECTION_WORDS: Record<'es' | 'pt' | 'fr', [RegExp, string][]> = {
  es: [
    [/^pre[\s-]*chorus/i, 'Pre Coro'],
    [/^post[\s-]*chorus/i, 'Post Coro'],
    [/^(chorus|refrain)/i, 'Coro'],
    [/^verse/i, 'Verso'],
    [/^bridge/i, 'Puente'],
    [/^(outro|ending|end)\b/i, 'Final'],
    [/^turn/i, 'Vuelta'],
    [/^interlude/i, 'Interludio'],
    [/^inst/i, 'Instrumental'],
  ],
  pt: [
    [/^pre[\s-]*chorus/i, 'Pré-Refrão'],
    [/^post[\s-]*chorus/i, 'Pós-Refrão'],
    [/^(chorus|refrain)/i, 'Refrão'],
    [/^verse/i, 'Verso'],
    [/^bridge/i, 'Ponte'],
    [/^(outro|ending|end)\b/i, 'Final'],
    [/^turn/i, 'Virada'],
    [/^interlude/i, 'Interlúdio'],
    [/^inst/i, 'Instrumental'],
  ],
  fr: [
    [/^pre[\s-]*chorus/i, 'Pré-refrain'],
    [/^post[\s-]*chorus/i, 'Post-refrain'],
    [/^(chorus|refrain)/i, 'Refrain'],
    [/^verse/i, 'Couplet'],
    [/^bridge/i, 'Pont'],
    [/^(outro|ending|end)\b/i, 'Fin'],
    [/^turn/i, 'Transition'],
    [/^interlude/i, 'Interlude'],
    [/^inst/i, 'Instrumental'],
  ],
}

const NUMBERS: Record<'en' | 'es' | 'pt' | 'fr', string[]> = {
  en: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'],
  es: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce'],
  pt: ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze'],
  fr: ['un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze'],
}

const base = (lang: Lang) => (lang === 'en-female' || lang === 'en-male' ? 'en' : lang)

/** What's said for a section; null for a count-in, which needs no cue. */
export function cuePhrase(name: string, lang: Lang): string | null {
  const n = name.trim()
  if (!n || /^count/i.test(n)) return null
  const b = base(lang)
  if (b === 'en') return n
  const num = /\s*(\d+)$/.exec(n)?.[1]
  const word = SECTION_WORDS[b].find(([re]) => re.test(n))?.[1]
  return word ? (num ? `${word} ${num}` : word) : n
}

/** The words counting the rest of a bar after the cue: "two", "three", "four" in 4/4. */
export function countWords(lang: Lang, beatsPerBar: number): string[] {
  return NUMBERS[base(lang)].slice(1, Math.min(beatsPerBar, 12))
}

/** Every phrase a song's cues need. */
export function songCuePhrases(song: Song, lang: Lang, countIn: boolean): string[] {
  const out = new Set<string>()
  for (const s of song.sections) {
    if (s.skip) continue
    const p = cuePhrase(s.name, lang)
    if (p) out.add(p)
  }
  if (countIn) countWords(lang, Math.max(...meterMap(song).map((m) => m.timeSig[0]))).forEach((w) => out.add(w))
  return [...out]
}

/** Mixes a (possibly differently sampled) recording into `data` at `at` seconds. */
function place(data: Float32Array, sr: number, at: number, sample: AudioBuffer) {
  const src = sample.getChannelData(0)
  const ratio = sample.sampleRate / sr
  const start = Math.round(at * sr)
  const len = Math.floor(src.length / ratio)
  for (let i = Math.max(0, -start); i < len && start + i < data.length; i++) {
    const x = i * ratio
    const j = Math.floor(x)
    const f = x - j
    data[start + i] += src[j] * (1 - f) + (src[j + 1] ?? 0) * f
  }
}

/**
 * The cue track for a song: each section's cue a bar before it (a section within the first bar
 * gets none), and with `countIn` the rest of that bar counted on the beats.
 */
export function renderCues(
  ctx: BaseAudioContext,
  song: Song,
  lang: Lang,
  countIn: boolean,
  samples: Map<string, AudioBuffer>,
): AudioBuffer | null {
  const first = samples.values().next().value as AudioBuffer | undefined
  if (!first) return null
  const sr = first.sampleRate
  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(song.duration * sr)), sr)
  const data = buf.getChannelData(0)
  for (const s of song.sections) {
    // A cut section isn't heard, so it isn't announced.
    if (s.skip) continue
    const phrase = cuePhrase(s.name, lang)
    // The bar before the section, through any tempo or time signature change.
    const beats = beatsBefore(song, s.start)
    const bar = beats.length ? beats[0].time : barBefore(song, s.start)
    // As heard: after a cut, the bar before is the end of the music before the cut, so the cue and
    // count go there (they're placed in the song's own time, which is what plays).
    const heardAt = toHeard(song, s.start) - (s.start - bar)
    const at = heardAt < -0.01 ? heardAt : toSong(song, heardAt)
    const shift = bar - at
    if (!phrase || at < -0.01) continue
    const sample = samples.get(phrase)
    if (sample) place(data, sr, Math.max(0, at), sample)
    if (!countIn) continue
    const words = countWords(lang, beats.length)
    beats.slice(1).forEach((b, k) => {
      const c = words[k] && samples.get(words[k])
      if (c) place(data, sr, b.time - shift, c)
    })
  }
  return buf
}
