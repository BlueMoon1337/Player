import { beatGrid } from './grid'
import { KEYS, type Section, type Song, type Stem, uid } from './types'

// ---------------------------------------------------------------------------
// Click track
// ---------------------------------------------------------------------------

export interface ClickBuffers {
  accent: AudioBuffer
  q: AudioBuffer
  e: AudioBuffer
  s: AudioBuffer
}

const CLICK_SAMPLE_RATE = 16000

/** The built-in click sounds (Settings ▸ Click Sound). */
export type ClickSoundName = 'classic' | 'woodblock' | 'hihat' | 'beep'

/** A seeded noise source, so a click sounds the same every time it's rendered. */
function noise(seed: number) {
  let x = seed
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 2 ** 31 - 1
  }
}

/**
 * One click (rendered once and stamped in for every beat). `freq` sets the pitch of the beat it
 * marks, accent highest: a sine burst (classic), a pitched knock (woodblock), a short noise tick
 * (hi-hat) or a square beep.
 */
function clickTemplate(sr: number, freq: number, amp: number, sound: ClickSoundName = 'classic'): Float32Array {
  const len = { classic: 0.035, woodblock: 0.05, hihat: 0.03, beep: 0.06 }[sound]
  const out = new Float32Array(Math.floor(sr * len))
  const rnd = noise(Math.round(freq))
  let hp = 0
  let prev = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const attack = Math.min(1, i / 8)
    if (sound === 'woodblock') {
      // Two inharmonic partials, a hard attack and a fast decay, like a wooden knock.
      const f = freq * 0.9
      out[i] = amp * attack * Math.exp(-t * 90) * (Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2.76 * t) * 0.3)
    } else if (sound === 'hihat') {
      // High-passed noise: brighter on the accent.
      const n = rnd()
      hp = 0.85 * (hp + n - prev)
      prev = n
      out[i] = amp * 1.3 * attack * Math.exp(-t * (freq > 1500 ? 110 : 160)) * hp
    } else if (sound === 'beep') {
      const sq = Math.sin(2 * Math.PI * freq * t) >= 0 ? 1 : -1
      out[i] = amp * 0.45 * attack * (t < len - 0.01 ? 1 : Math.max(0, (len - t) / 0.01)) * sq
    } else {
      out[i] = amp * Math.exp(-t * 140) * attack * Math.sin(2 * Math.PI * freq * t)
    }
  }
  return out
}

function writeClick(data: Float32Array, at: number, sr: number, tpl: Float32Array) {
  const start = Math.round(at * sr)
  const from = Math.max(0, -start)
  const to = Math.min(tpl.length, data.length - start)
  for (let i = from; i < to; i++) data[start + i] += tpl[i]
}

/**
 * Renders the click as four sample-accurate buffers (one per click channel) so they
 * can be started alongside the stems and stay locked to them, including through loops.
 */
export function renderClick(ctx: BaseAudioContext, song: Song, sound: ClickSoundName = 'classic'): ClickBuffers {
  // Clicks are tones of at most 1.65 kHz, so 16 kHz is plenty. Playback resamples them and
  // positions loops in fractional frames, so they stay locked to stems at any device rate,
  // at a third of the memory a full-rate render would take for a long song.
  const sr = CLICK_SAMPLE_RATE
  const length = Math.max(1, Math.ceil(song.duration * sr))
  const make = () => ctx.createBuffer(1, length, sr)
  const bufs = { accent: make(), q: make(), e: make(), s: make() }
  const a = bufs.accent.getChannelData(0)
  const q = bufs.q.getChannelData(0)
  const e = bufs.e.getChannelData(0)
  const s = bufs.s.getChannelData(0)
  const accentTpl = clickTemplate(sr, 1650, 0.9, sound)
  const quarterTpl = clickTemplate(sr, 1050, 0.75, sound)
  const eighthTpl = clickTemplate(sr, 880, 0.5, sound)
  const sixteenthTpl = clickTemplate(sr, 720, 0.35, sound)
  // Every beat of the song, through its tempo and time signature changes; pickups before the
  // click offset get a click too.
  for (const b of beatGrid(song)) {
    const t = b.time
    if (t < 0) continue
    if (b.index === 0) writeClick(a, t, sr, accentTpl)
    else writeClick(q, t, sr, quarterTpl)
    writeClick(e, t + b.length / 2, sr, eighthTpl)
    writeClick(s, t + b.length / 4, sr, sixteenthTpl)
    writeClick(s, t + (3 * b.length) / 4, sr, sixteenthTpl)
  }
  return bufs
}

// ---------------------------------------------------------------------------
// Demo songs
// ---------------------------------------------------------------------------

interface DemoSpec {
  title: string
  key: string
  bpm: number
  /** Chord roots as scale degrees (0-based, major scale), one chord per bar. */
  progression: number[]
  sections: [string, number, number][] // name, bars, intensity 0..3
  hue: number
}

const DEMOS: DemoSpec[] = [
  {
    title: 'Bright Morning',
    key: 'Db',
    bpm: 132,
    progression: [0, 4, 5, 3],
    hue: 200,
    sections: [
      ['Count-in', 1, 0],
      ['Intro', 4, 1],
      ['Verse 1', 8, 1],
      ['Verse 2', 8, 2],
      ['Pre-chorus', 4, 2],
      ['Chorus 1', 8, 3],
      ['Tag', 4, 3],
      ['Outro', 2, 1],
    ],
  },
  {
    title: 'Open Skies',
    key: 'G',
    bpm: 72,
    progression: [0, 3, 5, 4],
    hue: 30,
    sections: [
      ['Count-in', 1, 0],
      ['Intro', 2, 1],
      ['Verse 1', 4, 1],
      ['Chorus 1', 4, 2],
      ['Bridge', 4, 3],
      ['Chorus 2', 4, 3],
      ['Outro', 2, 1],
    ],
  },
  {
    title: 'River Song',
    key: 'E',
    bpm: 104,
    progression: [5, 3, 0, 4],
    hue: 140,
    sections: [
      ['Count-in', 1, 0],
      ['Intro', 4, 1],
      ['Verse 1', 8, 1],
      ['Chorus 1', 8, 3],
      ['Instrumental', 4, 2],
      ['Chorus 2', 8, 3],
      ['Ending', 2, 1],
    ],
  },
]

function artwork(hue: number, title: string): string {
  const initial = title.charAt(0)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,25%)"/></linearGradient></defs><rect width="80" height="80" fill="url(#g)"/><text x="40" y="52" font-family="sans-serif" font-size="34" font-weight="700" fill="rgba(255,255,255,0.85)" text-anchor="middle">${initial}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export function songArtwork(title: string): string {
  let h = 0
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360
  return artwork(h, title || '?')
}

/** Demo song metadata. Stems are rendered on demand by `renderDemoStems`. */
export function demoSongs(): Song[] {
  return DEMOS.map((d, i) => {
    const bar = (60 / d.bpm) * 4
    const sections: Section[] = []
    let t = 0
    for (const [name, bars] of d.sections) {
      sections.push({ id: uid('sec'), name, start: t })
      t += bars * bar
    }
    // Let the last chord ring for a bar.
    const duration = t + bar
    return {
      id: `demo-${i}`,
      title: d.title,
      artist: 'Player',
      album: 'Demo Songs',
      key: d.key,
      bpm: d.bpm,
      timeSig: [4, 4] as [number, number],
      clickOffset: 0,
      duration,
      sections,
      stems: [],
      artwork: artwork(d.hue, d.title),
      source: 'demo' as const,
    }
  })
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]

function mtof(m: number) {
  return 440 * Math.pow(2, (m - 69) / 12)
}

/** Deterministic PRNG so demo stems are identical each time they render. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function normalize(data: Float32Array, peak = 0.8) {
  let max = 0
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]))
  if (max > 0) {
    const g = peak / max
    for (let i = 0; i < data.length; i++) data[i] *= g
  }
}

export function renderDemoStems(ctx: BaseAudioContext, song: Song): Stem[] {
  const spec = DEMOS[Number(song.id.split('-')[1])]
  const sr = ctx.sampleRate
  const length = Math.ceil(song.duration * sr)
  const beat = 60 / spec.bpm
  const bar = beat * 4
  const rootMidi = 48 + KEYS.indexOf(spec.key as (typeof KEYS)[number])
  const rand = rng(1234 + spec.bpm)

  const drums = new Float32Array(length)
  const perc = new Float32Array(length)
  const bass = new Float32Array(length)
  const ag = new Float32Array(length)
  const eg = new Float32Array(length)
  const guide = new Float32Array(length)

  // Bar-by-bar plan: [intensity, chord degree, sectionName, isFirstBarOfSection]
  const bars: { intensity: number; degree: number; section: string; first: boolean }[] = []
  let chordIdx = 0
  for (const [name, count, intensity] of spec.sections) {
    for (let b = 0; b < count; b++) {
      const degree = intensity === 0 ? 0 : spec.progression[chordIdx++ % spec.progression.length]
      bars.push({ intensity, degree, section: name, first: b === 0 })
    }
    if (intensity > 0) chordIdx = 0
  }
  // Ring-out bar on the tonic.
  bars.push({ intensity: -1, degree: 0, section: 'end', first: false })

  const chordNotes = (degree: number) => {
    const root = rootMidi + MAJOR[degree % 7]
    const third = rootMidi + MAJOR[(degree + 2) % 7] + (degree + 2 >= 7 ? 12 : 0)
    const fifth = rootMidi + MAJOR[(degree + 4) % 7] + (degree + 4 >= 7 ? 12 : 0)
    return { root, third, fifth }
  }

  const kick = (at: number, amp: number) => {
    const n = Math.floor(sr * 0.35)
    const s0 = Math.round(at * sr)
    let phase = 0
    for (let i = 0; i < n && s0 + i < length; i++) {
      const t = i / sr
      const f = 45 + 90 * Math.exp(-t * 30)
      phase += (2 * Math.PI * f) / sr
      drums[s0 + i] += amp * Math.sin(phase) * Math.exp(-t * 9)
    }
  }
  const snare = (at: number, amp: number) => {
    const n = Math.floor(sr * 0.22)
    const s0 = Math.round(at * sr)
    for (let i = 0; i < n && s0 + i < length; i++) {
      const t = i / sr
      const noise = (rand() * 2 - 1) * Math.exp(-t * 22)
      const tone = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30)
      drums[s0 + i] += amp * (0.7 * noise + 0.5 * tone)
    }
  }
  const hat = (target: Float32Array, at: number, amp: number, decay: number) => {
    const n = Math.floor(sr * 0.08)
    const s0 = Math.round(at * sr)
    let prev = 0
    for (let i = 0; i < n && s0 + i < length; i++) {
      const t = i / sr
      const w = rand() * 2 - 1
      const hp = w - prev // crude high-pass
      prev = w
      target[s0 + i] += amp * hp * Math.exp(-t * decay)
    }
  }
  const pluck = (target: Float32Array, at: number, midi: number, amp: number, dur: number) => {
    // Karplus-Strong string.
    const period = Math.max(2, Math.round(sr / mtof(midi)))
    const buf = new Float32Array(period)
    for (let i = 0; i < period; i++) buf[i] = rand() * 2 - 1
    const n = Math.floor(sr * dur)
    const s0 = Math.round(at * sr)
    let idx = 0
    for (let i = 0; i < n && s0 + i < length; i++) {
      const next = (idx + 1) % period
      const v = buf[idx]
      buf[idx] = 0.497 * (v + buf[next])
      idx = next
      const fadeOut = i > n - 400 ? (n - i) / 400 : 1
      target[s0 + i] += amp * v * fadeOut
    }
  }
  const synthNote = (
    target: Float32Array,
    at: number,
    midi: number,
    amp: number,
    dur: number,
    shape: 'saw' | 'square' | 'sine',
    cutoff: number,
  ) => {
    const f = mtof(midi)
    const n = Math.floor(sr * dur)
    const s0 = Math.round(at * sr)
    const a = Math.exp((-2 * Math.PI * cutoff) / sr)
    let lp = 0
    let phase = 0
    for (let i = 0; i < n && s0 + i < length; i++) {
      phase = (phase + f / sr) % 1
      let v: number
      if (shape === 'saw') v = 2 * phase - 1
      else if (shape === 'square') v = phase < 0.5 ? 1 : -1
      else v = Math.sin(2 * Math.PI * phase)
      lp = (1 - a) * v + a * lp
      const env = Math.min(1, i / (sr * 0.005)) * Math.min(1, (n - i) / (sr * 0.03))
      target[s0 + i] += amp * lp * env
    }
  }
  const chime = (at: number, midi: number) => {
    const f = mtof(midi)
    const n = Math.floor(sr * 0.6)
    const s0 = Math.round(at * sr)
    for (let i = 0; i < n && s0 + i < length; i++) {
      const t = i / sr
      const env = Math.exp(-t * 6) * Math.min(1, i / 40)
      guide[s0 + i] +=
        env * (0.6 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 2.76 * t))
    }
  }

  for (let b = 0; b < bars.length; b++) {
    const { intensity, degree } = bars[b]
    const t0 = b * bar
    const { root, third, fifth } = chordNotes(degree)

    // Guide: a cue chime one bar before each section, pitched by section type.
    const nextBar = bars[b + 1]
    if (nextBar && nextBar.first && nextBar.intensity > 0) {
      const name = nextBar.section.toLowerCase()
      const cue = name.startsWith('chorus')
        ? 84
        : name.startsWith('verse')
          ? 76
          : name.startsWith('bridge')
            ? 81
            : name.startsWith('pre')
              ? 79
              : 72
      chime(t0, cue)
      chime(t0 + beat * 2, cue)
    }

    if (intensity === -1) {
      // Final ring-out chord.
      kick(t0, 0.9)
      for (const [k, m] of [root, third, fifth, root + 12].entries()) pluck(ag, t0 + k * 0.02, m, 0.5, bar)
      synthNote(bass, t0, root - 12, 0.6, bar * 0.9, 'saw', 300)
      continue
    }
    if (intensity === 0) continue

    // Drums
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * beat
      if (intensity >= 3 || i % 2 === 0) kick(t, 0.9)
      if (intensity >= 2 && i % 2 === 1) snare(t, 0.7)
      if (intensity === 1 && i === 3 && b % 2 === 1) snare(t, 0.3)
      hat(drums, t + beat / 2, intensity >= 2 ? 0.25 : 0.15, 60)
      if (intensity >= 2) hat(drums, t, 0.18, 70)
    }

    // Percussion: shaker 16ths on higher intensities, tambourine on 2 & 4 in big sections.
    if (intensity >= 2) {
      for (let i = 0; i < 16; i++) {
        hat(perc, t0 + (i * beat) / 4, i % 2 === 0 ? 0.12 : 0.2, 35)
      }
    }
    if (intensity >= 3) {
      hat(perc, t0 + beat, 0.5, 18)
      hat(perc, t0 + beat * 3, 0.5, 18)
    }

    // Bass
    if (intensity >= 3) {
      for (let i = 0; i < 8; i++) synthNote(bass, t0 + (i * beat) / 2, root - 12, 0.5, beat / 2 - 0.01, 'saw', 380)
    } else if (intensity === 2) {
      synthNote(bass, t0, root - 12, 0.55, beat * 2 - 0.02, 'saw', 320)
      synthNote(bass, t0 + beat * 2, root - 12, 0.55, beat * 1.5 - 0.02, 'saw', 320)
      synthNote(bass, t0 + beat * 3.5, fifth - 24, 0.45, beat / 2 - 0.02, 'saw', 320)
    } else {
      synthNote(bass, t0, root - 12, 0.5, bar - 0.02, 'sine', 400)
    }

    // Acoustic guitar strums
    const strumPattern = intensity >= 2 ? [0, 1, 1.5, 2.5, 3, 3.5] : [0, 2]
    for (const pos of strumPattern) {
      const up = pos % 1 !== 0
      const notes = [root, fifth, root + 12, third + 12]
      const order = up ? [...notes].reverse() : notes
      order.forEach((m, k) => pluck(ag, t0 + pos * beat + k * 0.012, m, up ? 0.25 : 0.4, beat * 1.5))
    }

    // Electric guitar: arpeggio in big sections, swells otherwise.
    if (intensity >= 3) {
      const arp = [root + 12, fifth + 12, third + 24, fifth + 12]
      for (let i = 0; i < 8; i++) {
        synthNote(eg, t0 + (i * beat) / 2, arp[i % 4], 0.3, beat / 2 - 0.02, 'square', 1800)
      }
    } else if (intensity === 2) {
      synthNote(eg, t0, third + 12, 0.25, bar - 0.05, 'saw', 900)
    }
  }

  // Simple dotted-eighth delay on the EG for some space.
  const delay = Math.round(beat * 0.75 * sr)
  for (let i = delay; i < length; i++) eg[i] += eg[i - delay] * 0.35

  const stems: [string, string, Float32Array][] = [
    ['guide', 'Guide', guide],
    ['drums', 'Drums', drums],
    ['perc', 'Perc', perc],
    ['bass', 'Bass', bass],
    ['ag', 'AG', ag],
    ['eg1', 'EG 1', eg],
  ]
  return stems.map(([id, name, data]) => {
    normalize(data, id === 'guide' ? 0.6 : 0.8)
    const buffer = ctx.createBuffer(1, length, sr)
    buffer.copyToChannel(data, 0)
    return { id, name, buffer }
  })
}
