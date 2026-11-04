/**
 * High-quality sample-rate conversion: a Kaiser-windowed sinc, applied polyphase.
 *
 * Stems are converted once, when they load, to the audio device's rate, so the browser plays
 * them sample for sample. Left to itself it converts while playing by straight-line
 * interpolation, which adds grit (images and aliases about 25 dB down) to anything bright:
 * cymbals, sibilance, the edge of a click. This keeps those artifacts out of the audible band.
 */

/** Zero crossings of the sinc on each side: 12 keeps images and aliases below about -75 dB. */
const ZEROS = 12
const BETA = 7.8
/** A passband edge of 94 % of the narrower Nyquist: flat to 20.7 kHz at 44.1 kHz. */
const CUTOFF = 0.94
/** Phases of the filter kept in the table; a ratio needing more is quantized to these. */
const MAX_PHASES = 4096

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** Converts one channel from `from` Hz to `to` Hz. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  return resampleChannels([input], from, to)[0]
}

/** Converts every channel of a stem from `from` Hz to `to` Hz (the filter is built once). */
export function resampleChannels(channels: Float32Array[], from: number, to: number): Float32Array[] {
  if (from === to || !channels.length) return channels
  const g = gcd(Math.round(from), Math.round(to))
  const L = Math.round(to) / g // output steps per M input samples
  const M = Math.round(from) / g
  const phases = Math.min(L, MAX_PHASES)
  // Cutoff in cycles per input sample: below the output's Nyquist when going down.
  const fc = 0.5 * CUTOFF * Math.min(1, to / from)
  const half = ZEROS / (2 * fc) // the filter's half-width, in input samples
  const H = Math.ceil(half)
  const taps = 2 * H
  const table = new Float64Array(phases * taps)
  const i0b = besselI0(BETA)
  for (let p = 0; p < phases; p++) {
    const frac = p / phases
    let sum = 0
    for (let j = 0; j < taps; j++) {
      const x = frac - (j - H + 1) // distance from the output position to input sample i + j - H + 1
      const r = x / half
      if (Math.abs(r) >= 1) continue
      const s = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x)
      const v = 2 * fc * s * (besselI0(BETA * Math.sqrt(1 - r * r)) / i0b)
      table[p * taps + j] = v
      sum += v
    }
    // Unity gain at DC for every phase.
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum
  }

  const inLen = channels[0].length
  const outLen = Math.round((inLen * L) / M)
  const SHIFT = 10
  const BLOCK = 1 << SHIFT
  return channels.map((input) => {
    const out = new Float32Array(outLen)
    // Stems are mostly silence between their parts: a block whose input is all zero stays zero.
    const silent = new Uint8Array(Math.ceil(inLen / BLOCK))
    for (let b = 0; b < silent.length; b++) {
      let any = 0
      for (let k = b * BLOCK, end = Math.min(inLen, k + BLOCK); k < end && !any; k++) if (input[k] !== 0) any = 1
      silent[b] = any ? 0 : 1
    }
    // The output position, stepped: input sample `whole` plus `rest` / L of the next.
    const stepWhole = Math.floor(M / L)
    const stepRest = M - stepWhole * L
    let whole = 0
    let rest = 0
    for (let n = 0; n < outLen; n++, whole += stepWhole, rest += stepRest) {
      if (rest >= L) {
        rest -= L
        whole++
      }
      let i = whole
      let p = rest
      if (phases !== L) {
        p = Math.round((rest / L) * phases)
        if (p === phases) {
          p = 0
          i++
        }
      }
      const k0 = i - H + 1
      const b0 = Math.max(0, k0) >> SHIFT
      const b1 = Math.min(inLen - 1, k0 + taps - 1) >> SHIFT
      if (b1 < 0 || b0 >= silent.length || (silent[b0] && silent[b1])) continue
      const base = p * taps
      let acc = 0
      if (k0 >= 0 && k0 + taps <= inLen) {
        for (let j = 0; j < taps; j++) acc += table[base + j] * input[k0 + j]
      } else {
        for (let j = 0; j < taps; j++) {
          const k = k0 + j
          if (k >= 0 && k < inLen) acc += table[base + j] * input[k]
        }
      }
      out[n] = acc
    }
    return out
  })
}
