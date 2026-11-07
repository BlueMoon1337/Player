import { pickPadFile } from '../import/pads'
import { type AudioInput, decodeAudio } from './decoder'
import { KEYS } from './types'

/** The pad sounds to choose from: how bright, how much it moves, and which partials. */
export const PAD_SOUNDS = [
  { id: 'warm', name: 'Warm Ambient Pad', cutoff: 900, sweep: 400, partials: [0, 7, 12, 14, 19], wave: 'sawtooth', hue: 28 },
  { id: 'bright', name: 'Bright Ambient Pad', cutoff: 2200, sweep: 900, partials: [0, 7, 12, 19, 24, 26], wave: 'sawtooth', hue: 200 },
  { id: 'soft', name: 'Soft Ambient Pad', cutoff: 700, sweep: 250, partials: [0, 7, 12, 19], wave: 'triangle', hue: 280 },
] as const

export type PadSoundId = (typeof PAD_SOUNDS)[number]['id']

/** One WAV of an imported pad: the key its name gives, and where to read it (or how). */
export interface PadFile {
  key: string | null
  name: string
  input: AudioInput | (() => Promise<AudioInput>)
}

/** A pad imported from a zip of WAVs (usually one per key). */
export interface ImportedPad {
  id: string
  name: string
  files: PadFile[]
}

interface Voice {
  gain: GainNode
  nodes: AudioScheduledSourceNode[]
  /** Timers that schedule an imported pad's next loop pass. */
  timers: number[]
  stopped: boolean
}

/** Decoded pad WAVs kept for quick key changes (they're large, so only a few). */
const CACHED_FILES = 3

/**
 * Ambient pad generator. Runs independently of the transport so it can carry
 * between songs, like a pad player on stage.
 */
export class PadPlayer {
  private out: GainNode
  private analyser: AnalyserNode
  private voice: Voice | null = null
  private imported = new Map<string, ImportedPad>()
  private buffers = new Map<string, Promise<AudioBuffer>>()
  key: string = 'C'
  volume = 0.5
  on = false
  /** A built-in sound's id, or an imported pad's. */
  sound: string = 'warm'
  /** Called when an imported pad's WAV can't be read. */
  onError?: (message: string) => void

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain()
    this.out.gain.value = this.volume
    this.out.connect(ctx.destination)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.out.connect(this.analyser)
  }

  /** Sends the pad somewhere else than straight to the device (the engine's outputs). */
  connectTo(node: AudioNode) {
    this.out.disconnect()
    this.out.connect(this.analyser)
    this.out.connect(node)
  }

  /** Peak level of the pad's output, for its meter. */
  meter(): number {
    if (!this.on && !this.voice) return 0
    const data = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(data)
    let peak = 0
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
    return peak
  }

  /** Crossfades to another sound (built in or imported) if the pad is playing. */
  setSound(id: string) {
    if (id === this.sound) return
    this.sound = id
    if (this.on) {
      this.stopVoice()
      this.voice = this.startVoice(this.key)
    }
  }

  /** The imported pads on offer. If the one playing is gone, the pad goes back to the first built-in sound. */
  setImported(pads: ImportedPad[]) {
    this.imported = new Map(pads.map((p) => [p.id, p]))
    for (const k of [...this.buffers.keys()]) if (!this.imported.has(k.split('/')[0])) this.buffers.delete(k)
    if (!PAD_SOUNDS.some((s) => s.id === this.sound) && !this.imported.has(this.sound)) this.setSound(PAD_SOUNDS[0].id)
  }

  /** An imported pad's WAV, decoded (the last few are kept). */
  private buffer(padId: string, file: PadFile): Promise<AudioBuffer> {
    const k = `${padId}/${file.name}`
    let p = this.buffers.get(k)
    if (!p) {
      p = (async () => {
        const input = typeof file.input === 'function' ? await file.input() : file.input
        return (await decodeAudio(this.ctx, input)).buffer
      })()
      p.catch(() => this.buffers.delete(k))
    }
    this.buffers.delete(k)
    this.buffers.set(k, p)
    while (this.buffers.size > CACHED_FILES) this.buffers.delete(this.buffers.keys().next().value!)
    return p
  }

  /**
   * An imported pad: the WAV for the key (or the nearest one, pitched), looped. Each pass
   * crossfades into the next, which starts a few seconds in, past the fade-in pads often have.
   */
  private startSampleVoice(pad: ImportedPad, key: string): Voice {
    const ctx = this.ctx
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(this.out)
    const voice: Voice = { gain, nodes: [], timers: [], stopped: false }
    const pick = pickPadFile(pad.files, key)
    if (!pick) return voice
    const rate = 2 ** (pick.shift / 12)
    this.buffer(pad.id, pick.file)
      .then((buf) => {
        if (voice.stopped) return
        const dur = buf.duration
        const xf = Math.min(4, dur / 4)
        const loopIn = Math.min(6, dur / 3)
        const play = (offset: number, when: number, fadeIn: number) => {
          const src = ctx.createBufferSource()
          src.buffer = buf
          src.playbackRate.value = rate
          const g = ctx.createGain()
          src.connect(g).connect(gain)
          const end = when + (dur - offset) / rate
          const fadeOut = end - xf / rate
          g.gain.setValueAtTime(fadeIn ? 0 : 1, when)
          if (fadeIn) g.gain.linearRampToValueAtTime(1, when + fadeIn / rate)
          g.gain.setValueAtTime(1, fadeOut)
          g.gain.linearRampToValueAtTime(0, end)
          src.start(when, offset)
          src.stop(end + 0.05)
          voice.nodes.push(src)
          src.onended = () => {
            voice.nodes = voice.nodes.filter((n) => n !== src)
            g.disconnect()
          }
          // Line up the next pass a second before it's due.
          const lead = (fadeOut - ctx.currentTime - 1) * 1000
          voice.timers.push(window.setTimeout(() => !voice.stopped && play(loopIn, fadeOut, xf), Math.max(0, lead)))
        }
        const start = ctx.currentTime + 0.02
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(1, start + 3)
        play(0, start, 0)
      })
      .catch((e: Error) => this.onError?.(`Couldn't play “${pad.name}” (${pick.file.name}): ${e.message}`))
    return voice
  }

  private startVoice(key: string): Voice {
    const imported = this.imported.get(this.sound)
    if (imported) return this.startSampleVoice(imported, key)
    const sound = PAD_SOUNDS.find((s) => s.id === this.sound) ?? PAD_SOUNDS[0]
    const ctx = this.ctx
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.18, now + 3)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = sound.cutoff
    filter.Q.value = 0.7
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.08
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = sound.sweep
    lfo.connect(lfoGain).connect(filter.frequency)
    filter.connect(gain).connect(this.out)

    const root = 48 + KEYS.indexOf(key as (typeof KEYS)[number])
    const nodes: AudioScheduledSourceNode[] = [lfo]
    // Root, fifths, octaves and ninths: no third, so it sits under major or minor.
    for (const interval of sound.partials) {
      const f = 440 * Math.pow(2, (root + interval - 69) / 12)
      for (const detune of [-8, 0, 8]) {
        const osc = ctx.createOscillator()
        osc.type = interval === 0 ? 'triangle' : sound.wave
        osc.frequency.value = f
        osc.detune.value = detune
        const g = ctx.createGain()
        g.gain.value = interval === 0 ? 0.5 : 0.12
        osc.connect(g).connect(filter)
        osc.start(now)
        nodes.push(osc)
      }
    }
    lfo.start(now)
    return { gain, nodes, timers: [], stopped: false }
  }

  private stopVoice(fade = 2.5) {
    const v = this.voice
    if (!v) return
    v.stopped = true
    v.timers.forEach((t) => window.clearTimeout(t))
    const now = this.ctx.currentTime
    v.gain.gain.cancelScheduledValues(now)
    v.gain.gain.setValueAtTime(v.gain.gain.value, now)
    v.gain.gain.linearRampToValueAtTime(0, now + fade)
    for (const n of v.nodes) {
      try {
        n.stop(now + fade + 0.1)
      } catch {
        /* already stopped */
      }
    }
    window.setTimeout(() => v.gain.disconnect(), (fade + 0.3) * 1000)
    this.voice = null
  }

  /**
   * Turns the pad on or off at once, in the order asked. Only waking the audio context up waits:
   * an "on" that waited for it before starting could finish after a later "off" and leave the
   * pad playing while it shows as off.
   */
  async setOn(on: boolean) {
    this.on = on
    if (!on) {
      this.stopVoice()
      return
    }
    if (!this.voice) this.voice = this.startVoice(this.key)
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  /** Crossfades to a new key if the pad is playing. */
  setKey(key: string) {
    if (key === this.key) return
    this.key = key
    if (this.on) {
      this.stopVoice()
      this.voice = this.startVoice(key)
    }
  }

  setVolume(v: number) {
    this.volume = v
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05)
  }
}
