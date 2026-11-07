import type { WavMeta } from './wav'

/** Raw file bytes, a File/Blob, or a URL (e.g. a library stem) for the worker to read itself. */
export type AudioInput = ArrayBuffer | Blob | string

export interface DecodeRequest {
  id: number
  input: AudioInput
  /** The rate to deliver the samples at (the audio context's): converted in the worker if the file's differs. */
  sampleRate: number
}

export type DecodeResponse =
  | { id: number; kind: 'pcm'; sampleRate: number; channels: Float32Array[]; folded: boolean; meta: WavMeta }
  | { id: number; kind: 'fallback'; data: ArrayBuffer; meta: WavMeta | null; encoding: string | null }
  | { id: number; kind: 'error'; message: string }

export interface DecodedAudio {
  buffer: AudioBuffer
  meta: WavMeta | null
}

/** Stereo files whose channels were the same, kept as one channel; they're played on both sides. */
const foldedStereo = new WeakSet<AudioBuffer>()
export const isFoldedStereo = (buffer: AudioBuffer) => foldedStereo.has(buffer)

/**
 * Frees audio that's been let go, now (the desktop app allows it): a song's stems take gigabytes,
 * and the next song shouldn't be read while the last one's are still waiting to be collected.
 */
export function freeMemory() {
  ;(globalThis as { gc?: () => void }).gc?.()
}

/** Running out of memory, as opposed to a file that can't be read. */
export const isOutOfMemory = (e: unknown) => /allocation failed|out of memory|createBuffer\(/i.test((e as Error)?.message ?? '')

/** Frames copied per slice: ~2 MB per channel, a few tens of ms even on slow memory. */
const COPY_SLICE = 1 << 19

/**
 * AudioBuffers can only be filled on the main thread, and writing a long stem into fresh
 * memory takes most of a second, so copy in slices and let frames render in between.
 */
async function fillBuffer(buffer: AudioBuffer, channels: Float32Array[]) {
  for (let off = 0; off < buffer.length; off += COPY_SLICE) {
    channels.forEach((c, i) => buffer.copyToChannel(c.subarray(off, off + COPY_SLICE), i, off))
    if (off + COPY_SLICE < buffer.length) await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * Several decoders, one per spare CPU core (up to four), so a song's stems decode side by side:
 * a MultiTracks song can have twenty stems of a minute's decoding work between them.
 */
export const DECODERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))

interface PooledWorker {
  worker: Worker
  busy: number
}
const pool: PooledWorker[] = []
let nextId = 1
const pending = new Map<number, (r: DecodeResponse) => void>()

/** The least busy decoder (starting new ones until the pool is full). */
function getWorker(): Worker {
  let pick = pool.find((w) => w.busy === 0)
  if (!pick && pool.length < DECODERS) {
    const worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })
    const entry: PooledWorker = { worker, busy: 0 }
    worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
      entry.busy--
      pending.get(e.data.id)?.(e.data)
      pending.delete(e.data.id)
    }
    pool.push(entry)
    pick = entry
  }
  pick ??= pool.reduce((a, b) => (b.busy < a.busy ? b : a))
  pick.busy++
  return pick.worker
}

/** Runs `fn` over `items` with at most `limit` at a time; results stay in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return out
}

/**
 * Decodes an audio file at the context's sample rate. The worker reads and decodes WAVs (with
 * markers/tempo metadata) and converts them to that rate with a high-quality filter, so large
 * stems never block the UI; anything else falls back to the browser decoder, which converts
 * them itself. Takes ownership of an ArrayBuffer input.
 */
export async function decodeAudio(ctx: BaseAudioContext, input: AudioInput): Promise<DecodedAudio> {
  const id = nextId++
  const res = await new Promise<DecodeResponse>((resolve) => {
    pending.set(id, resolve)
    getWorker().postMessage({ id, input, sampleRate: ctx.sampleRate } satisfies DecodeRequest, input instanceof ArrayBuffer ? [input] : [])
  })
  if (res.kind === 'error') throw new Error(res.message)
  if (res.kind === 'pcm') {
    const buffer = ctx.createBuffer(res.channels.length, res.channels[0].length, res.sampleRate)
    await fillBuffer(buffer, res.channels)
    if (res.folded) foldedStereo.add(buffer)
    return { buffer, meta: res.meta }
  }
  try {
    return { buffer: await ctx.decodeAudioData(res.data), meta: res.meta }
  } catch {
    throw new Error(res.encoding ? `unsupported WAV encoding (${res.encoding})` : 'not a format this app can decode')
  }
}
