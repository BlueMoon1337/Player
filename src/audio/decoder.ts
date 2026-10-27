import type { WavMeta } from './wav'

/** Raw file bytes, a File/Blob, or a URL (e.g. a library stem) for the worker to read itself. */
export type AudioInput = ArrayBuffer | Blob | string

export interface DecodeRequest {
  id: number
  input: AudioInput
}

export type DecodeResponse =
  | { id: number; kind: 'pcm'; sampleRate: number; channels: Float32Array[]; meta: WavMeta }
  | { id: number; kind: 'fallback'; data: ArrayBuffer; meta: WavMeta | null; encoding: string | null }
  | { id: number; kind: 'error'; message: string }

export interface DecodedAudio {
  buffer: AudioBuffer
  meta: WavMeta | null
}

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

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (r: DecodeResponse) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
      pending.get(e.data.id)?.(e.data)
      pending.delete(e.data.id)
    }
  }
  return worker
}

/**
 * Decodes an audio file. The worker reads and decodes WAVs at their native sample rate
 * (with markers/tempo metadata), so large stems never block the UI; anything else falls
 * back to the browser decoder. Takes ownership of an ArrayBuffer input.
 */
export async function decodeAudio(ctx: BaseAudioContext, input: AudioInput): Promise<DecodedAudio> {
  const id = nextId++
  const res = await new Promise<DecodeResponse>((resolve) => {
    pending.set(id, resolve)
    getWorker().postMessage({ id, input } satisfies DecodeRequest, input instanceof ArrayBuffer ? [input] : [])
  })
  if (res.kind === 'error') throw new Error(res.message)
  if (res.kind === 'pcm') {
    const buffer = ctx.createBuffer(res.channels.length, res.channels[0].length, res.sampleRate)
    await fillBuffer(buffer, res.channels)
    return { buffer, meta: res.meta }
  }
  try {
    return { buffer: await ctx.decodeAudioData(res.data), meta: res.meta }
  } catch {
    throw new Error(res.encoding ? `unsupported WAV encoding (${res.encoding})` : 'not a format this app can decode')
  }
}
