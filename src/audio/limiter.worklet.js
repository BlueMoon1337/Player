/**
 * The output limiter, as an AudioWorklet (plain JavaScript: it's loaded into the audio thread as is).
 *
 * It looks 1.5 ms ahead, so the gain is already down when a peak arrives: no overs, and the
 * gain eases down over those 1.5 ms instead of snapping, which is what a compressor's attack on a
 * click sounds like (crunch). Below the ceiling the sound passes untouched, only delayed.
 * Channels are linked, so a stereo image doesn't shift. Options: ceiling (dBFS), release (s).
 */
class Limiter extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions ?? {}
    this.ceiling = 10 ** ((o.ceiling ?? -1) / 20)
    this.lookahead = Math.max(1, Math.round((o.lookahead ?? 0.0015) * sampleRate))
    this.recover = 1 - Math.exp(-1 / ((o.release ?? 0.08) * sampleRate))
    const n = this.lookahead + 1
    this.delay = [new Float32Array(n), new Float32Array(n)]
    this.wanted = new Float32Array(n) // the gain each sample in the window needs
    this.box = new Float32Array(n) // the held gain over the last window, averaged into a smooth ramp
    this.boxSum = n
    this.box.fill(1)
    this.wanted.fill(1)
    this.pos = 0
    this.held = 1
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    const channels = Math.min(output.length, 2)
    if (!channels) return true
    const frames = output[0].length
    const n = this.lookahead + 1
    for (let i = 0; i < frames; i++) {
      let peak = 0
      for (let c = 0; c < channels; c++) {
        const x = input[c] ? input[c][i] : input[0] ? input[0][i] : 0
        const a = x < 0 ? -x : x
        if (a > peak) peak = a
      }
      const need = peak > this.ceiling ? this.ceiling / peak : 1
      const p = this.pos
      this.wanted[p] = need
      // The lowest gain any sample still in the window needs: held until it has passed.
      let low = need
      for (let k = 0; k < n; k++) if (this.wanted[k] < low) low = this.wanted[k]
      // Down at once (the averaging below makes the ramp), back up gently.
      this.held = low < this.held ? low : this.held + (Math.min(1, low) - this.held) * this.recover
      this.boxSum += this.held - this.box[p]
      this.box[p] = this.held
      const gain = Math.min(1, this.boxSum / n)
      // The sample leaving the window now.
      const out = (p + 1) % n
      for (let c = 0; c < channels; c++) {
        const x = input[c] ? input[c][i] : input[0] ? input[0][i] : 0
        output[c][i] = this.delay[c][out] * gain
        this.delay[c][p] = x
      }
      this.pos = out
    }
    return true
  }
}

registerProcessor('player-limiter', Limiter)
