/// <reference lib="webworker" />
import { resampleChannels } from './resample'
import { readWav } from './wav'
import type { DecodeRequest, DecodeResponse } from './decoder'

async function read(input: DecodeRequest['input']): Promise<ArrayBuffer> {
  if (input instanceof ArrayBuffer) return input
  if (input instanceof Blob) return input.arrayBuffer()
  const res = await fetch(input)
  if (!res.ok) throw new Error(res.status === 404 ? 'file is missing from the library folder' : `HTTP ${res.status}`)
  return res.arrayBuffer()
}

// Reading and decoding happen here so even very large stems never stall the UI (assembling a
// 100 MB file into one buffer alone takes ~0.4 s). Formats other than WAV need the browser's
// decoder, which only exists on the main thread, so those bytes are handed back.
/** Whether a stereo stem is the same sound in both channels (a mono part in a stereo file). */
function dualMono(channels: Float32Array[]): boolean {
  if (channels.length !== 2) return false
  const [l, r] = channels
  for (let i = 0; i < l.length; i++) if (l[i] !== r[i]) return false
  return true
}

/** The file's samples (the file itself is let go before they're converted), or the file if it isn't a WAV we decode. */
async function decode(input: DecodeRequest['input']) {
  const data = await read(input)
  const wav = readWav(data)
  if (!wav?.decodeChannels) return { pcm: null, data, wav }
  return { pcm: { channels: wav.decodeChannels(), sampleRate: wav.sampleRate, meta: wav.meta }, data: null, wav: null }
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, input, sampleRate } = e.data
  let res: DecodeResponse
  let transfer: Transferable[] = []
  try {
    const { pcm, data, wav } = await decode(input)
    if (pcm) {
      // A mono part in a stereo file is kept once: half the memory, played at the same level.
      const folded = dualMono(pcm.channels)
      const kept = folded ? [pcm.channels[0]] : pcm.channels
      pcm.channels = []
      // At the device's rate, so playback never converts it on the fly (which sounds gritty).
      const channels = resampleChannels(kept, pcm.sampleRate, sampleRate || pcm.sampleRate)
      res = { id, kind: 'pcm', sampleRate: sampleRate || pcm.sampleRate, channels, folded, meta: pcm.meta }
      transfer = channels.map((c) => c.buffer)
    } else {
      res = { id, kind: 'fallback', data: data!, meta: wav?.meta ?? null, encoding: wav?.encoding ?? null }
      transfer = [data!]
    }
  } catch (err) {
    res = { id, kind: 'error', message: (err as Error).message }
  }
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(res, transfer)
}
