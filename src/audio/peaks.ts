import type { Stem } from './types'

/** Summed absolute-peak overview of all stems, normalised to 0..1, `bins` points long. */
export function computePeaks(stems: Stem[], duration: number, bins = 2400): Float32Array {
  const out = new Float32Array(bins)
  for (const { buffer } of stems) {
    const sr = buffer.sampleRate
    const perBin = (duration * sr) / bins
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c)
      for (let b = 0; b < bins; b++) {
        const from = Math.floor(b * perBin)
        const to = Math.min(data.length, Math.floor((b + 1) * perBin))
        let max = 0
        // Stride through long bins; peaks are only for display.
        const step = Math.max(1, Math.floor((to - from) / 256))
        for (let i = from; i < to; i += step) {
          const v = Math.abs(data[i])
          if (v > max) max = v
        }
        out[b] += max / buffer.numberOfChannels
      }
    }
  }
  let max = 0
  for (let i = 0; i < bins; i++) max = Math.max(max, out[i])
  if (max > 0) for (let i = 0; i < bins; i++) out[i] /= max
  return out
}
