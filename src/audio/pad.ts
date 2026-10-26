import { KEYS } from './types'

/**
 * Ambient pad generator. Runs independently of the transport so it can carry
 * between songs, like a pad player on stage.
 */
export class PadPlayer {
  private out: GainNode
  private voice: { gain: GainNode; nodes: AudioScheduledSourceNode[] } | null = null
  key: string = 'C'
  volume = 0.5
  on = false

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain()
    this.out.gain.value = this.volume
    this.out.connect(ctx.destination)
  }

  private startVoice(key: string) {
    const ctx = this.ctx
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.18, now + 3)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 900
    filter.Q.value = 0.7
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.08
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 400
    lfo.connect(lfoGain).connect(filter.frequency)
    filter.connect(gain).connect(this.out)

    const root = 48 + KEYS.indexOf(key as (typeof KEYS)[number])
    const nodes: AudioScheduledSourceNode[] = [lfo]
    // Root, fifth, octave, ninth: no third, so it sits under major or minor.
    for (const interval of [0, 7, 12, 14, 19]) {
      const f = 440 * Math.pow(2, (root + interval - 69) / 12)
      for (const detune of [-8, 0, 8]) {
        const osc = ctx.createOscillator()
        osc.type = interval === 0 ? 'triangle' : 'sawtooth'
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
