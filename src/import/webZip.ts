/**
 * Zips in the web version: read straight from the dropped File with Blob.slice, inflating each
 * stem with the browser's DecompressionStream, so a 1 GB download is never held in memory whole.
 */
import type { StemSource } from '../audio/importer'
import { type AbletonSong, parseAbleton } from './ableton'
import { type SongName, parseSongName, pickFiles } from './multitracks'
import { type ZipEntry, type ZipSource, baseName, checkSupported, crc32, dataStart, listZip } from './zip'

export interface WebZipSong {
  name: SongName
  sources: StemSource[]
  artwork?: string
  ableton: AbletonSong | null
  failed: { name: string; reason: string }[]
}

function blobSource(file: Blob): ZipSource {
  return { size: file.size, read: async (o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer()) }
}

/** One file out of the zip, inflated and checked against its CRC-32 (a damaged download is caught here). */
async function entryBlob(file: Blob, src: ZipSource, entry: ZipEntry): Promise<Blob> {
  checkSupported(entry)
  const start = await dataStart(src, entry)
  const raw = file.slice(start, start + entry.compressedSize).stream()
  const bytes = entry.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'))
  let crc = 0
  let size = 0
  const checked = bytes.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        crc = crc32(chunk, crc)
        size += chunk.length
        out.enqueue(chunk)
      },
    }),
  )
  let blob: Blob
  try {
    blob = await new Response(checked).blob()
  } catch (e) {
    throw new Error(`couldn't unzip it (${(e as Error).message})`)
  }
  if (size !== entry.size || crc !== entry.crc32 >>> 0) throw new Error('it is damaged in the zip (checksum mismatch)')
  return blob
}

export async function readZipSong(file: File): Promise<WebZipSong> {
  const src = blobSource(file)
  const entries = await listZip(src)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const picked = pickFiles(entries.map((e) => e.name))
  if (!picked.stems.length) throw new Error('there are no audio files in the zip')
  const failed: WebZipSong['failed'] = []
  // Inflated only when it's that stem's turn to be decoded, not all up front.
  const sources: StemSource[] = picked.stems.map((n) => ({
    name: baseName(n),
    input: () => entryBlob(file, src, byName.get(n)!),
  }))
  let artwork: string | undefined
  if (picked.artwork) {
    try {
      artwork = URL.createObjectURL(await entryBlob(file, src, byName.get(picked.artwork)!))
    } catch {
      /* no cover, then */
    }
  }
  let ableton: AbletonSong | null = null
  if (picked.ableton) {
    try {
      const raw = await entryBlob(file, src, byName.get(picked.ableton)!)
      const head = new Uint8Array(await raw.slice(0, 2).arrayBuffer())
      const xmlBlob = head[0] === 0x1f && head[1] === 0x8b ? await new Response(raw.stream().pipeThrough(new DecompressionStream('gzip'))).blob() : raw
      const xml = await xmlBlob.text()
      ableton = xml.includes('<Ableton') ? parseAbleton(xml, parseSongName(file.name).bpm) : null
    } catch {
      ableton = null
    }
  }
  return { name: parseSongName(file.name), sources, artwork, ableton, failed }
}
