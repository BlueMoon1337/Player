import { KEYS } from './types'

/** The pad sounds to choose from: how bright, how much it moves, and which partials. */
export const PAD_SOUNDS = [
  { id: 'warm', name: 'Warm Ambient Pad', cutoff: 900, sweep: 400, partials: [0, 7, 12, 14, 19], wave: 'sawtooth', hue: 28 },
  { id: 'bright', name: 'Bright Ambient Pad', cutoff: 2200, sweep: 900, partials: [0, 7, 12, 19, 24, 26], wave: 'sawtooth', hue: 200 },
  { id: 'soft', name: 'Soft Ambient Pad', cutoff: 700, sweep: 250, partials: [0, 7, 12, 19], wave: 'triangle', hue: 280 },
] as const

export type PadSoundId = (typeof PAD_SOUNDS)[number]['id']

/**
 * Ambient pad generator. Runs independently of the transport so it can carry
 * between songs, like a pad player on stage.
 */
export class PadPlayer {
  private out: GainNode
  private analyser: AnalyserNode
  private voice: { gain: GainNode; nodes: AudioScheduledSourceNode[] } | null = null
  key: string = 'C'
  volume = 0.5
  on = false
  sound: PadSoundId = 'warm'

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain()
    this.out.gain.value = this.volume
    this.out.connect(ctx.destination)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.out.connect(this.analyser)
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

  /** Crossfades to another sound if the pad is playing. */
  setSound(id: PadSoundId) {
    if (id === this.sound) return
    this.sound = id
    if (this.on) {
      this.stopVoice()
      this.voice = this.startVoice(this.key)
    }
  }

  private startVoice(key: string) {
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
    return { gain, nodes }
  }

  private stopVoice(fade = 2.5) {
    const v = this.voice
    if (!v) return
    const now = this.ctx.currentTime
    v.gain.gain.cancelScheduledValues(now)
    v.gain.gain.setValueAtTime(v.gain.gain.value, now)
    v.gain.gain.linearRampToValueAtTime(0, now + fade)
    v.nodes.forEach((n) => n.stop(now + fade + 0.1))
    this.voice = null
  }

  async setOn(on: boolean) {
    if (this.ctx.state !== 'running') await this.ctx.resume()
    this.on = on
    if (on && !this.voice) this.voice = this.startVoice(this.key)
    if (!on) this.stopVoice()
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
