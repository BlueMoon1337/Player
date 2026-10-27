/// <reference lib="webworker" />
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
self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, input } = e.data
  let res: DecodeResponse
  let transfer: Transferable[] = []
  try {
    const data = await read(input)
    const wav = readWav(data)
    if (wav?.decodeChannels) {
      const channels = wav.decodeChannels()
      res = { id, kind: 'pcm', sampleRate: wav.sampleRate, channels, meta: wav.meta }
      transfer = channels.map((c) => c.buffer)
    } else {
      res = { id, kind: 'fallback', data, meta: wav?.meta ?? null, encoding: wav?.encoding ?? null }
      transfer = [data]
    }
  } catch (err) {
    res = { id, kind: 'error', message: (err as Error).message }
  }
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(res, transfer)
}
