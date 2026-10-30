/**
 * WAV (RIFF / RF64 / BW64) reader.
 *
 * Decodes PCM 8/16/24/32-bit, IEEE float 32/64-bit, A-law and µ-law, including
 * WAVE_FORMAT_EXTENSIBLE files, at the file's native sample rate. Also reads the
 * metadata DAWs embed in exported stems: cue markers with labels (cue + LIST/adtl),
 * tempo and meter (acid), and the title, artist, album and the program that wrote the file
 * (LIST/INFO INAM, IART, IPRD, ISFT). KeyFinder also writes a "bmap" chunk: the song's beat map
 * (where bar 1 falls, its tempo changes and time signature changes) as JSON:
 *   {"version": 1, "offset": 0.52, "tempos": [[0, 156.0], [95.3, 150.2]], "meters": [[0, 4, 4], [61.0, 2, 4]]}
 * with times in seconds.
 */

/** A song's beats as KeyFinder found them (its "bmap" chunk). */
export interface BeatMap {
  /** Seconds to bar 1, beat 1. */
  offset: number
  tempos: { start: number; bpm: number }[]
  meters: { start: number; timeSig: [number, number] }[]
}

export interface WavMarker {
  time: number
  label: string
}

export interface WavMeta {
  markers: WavMarker[]
  bpm: number | null
  timeSig: [number, number] | null
  title: string | null
  artist: string | null
  album: string | null
  /** The program that wrote the file (ISFT), e.g. "KeyFinder". */
  software: string | null
  beatMap: BeatMap | null
}

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** A "bmap" chunk's JSON, or null if it isn't one this reader understands. */
export function parseBeatMap(json: string): BeatMap | null {
  try {
    const m = JSON.parse(json)
    if (m?.version !== 1 || !Array.isArray(m.tempos) || !Array.isArray(m.meters)) return null
    const tempos = m.tempos
      .filter((t: unknown) => Array.isArray(t) && num(t[0], 0, 1e6) && num(t[1], 10, 999))
      .map((t: number[]) => ({ start: t[0], bpm: t[1] }))
    const meters = m.meters
      .filter((x: unknown) => Array.isArray(x) && num(x[0], 0, 1e6) && num(x[1], 1, 32) && [2, 4, 8, 16].includes(x[2]))
      .map((x: number[]) => ({ start: x[0], timeSig: [x[1], x[2]] as [number, number] }))
    if (!tempos.length) return null
    return { offset: num(m.offset, 0, 1e6) ? m.offset : 0, tempos, meters }
  } catch {
    return null
  }
}

export interface WavFile {
  sampleRate: number
  channels: number
  frames: number
  /** Human-readable sample encoding, e.g. "24-bit PCM". */
  encoding: string
  meta: WavMeta
  /**
   * Decodes to one Float32Array per channel. Needs no AudioContext, so it can run in a worker.
   * Null when the sample encoding isn't one we decode; let the browser try instead.
   */
  decodeChannels: (() => Float32Array[]) | null
}

export class WavError extends Error {}

const FORMAT_NAMES: Record<number, string> = {
  0x0002: 'MS ADPCM',
  0x0011: 'IMA ADPCM',
  0x0055: 'MP3',
  0x0161: 'WMA',
  0x2000: 'AC-3',
}

let alawTable: Float32Array | null = null
let ulawTable: Float32Array | null = null

function g711Table(kind: 'alaw' | 'ulaw'): Float32Array {
  if (kind === 'alaw' && alawTable) return alawTable
  if (kind === 'ulaw' && ulawTable) return ulawTable
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    let v: number
    if (kind === 'ulaw') {
      const u = ~i & 0xff
      const exp = (u >> 4) & 7
      const mant = u & 0x0f
      v = (((mant << 3) + 0x84) << exp) - 0x84
      if (u & 0x80) v = -v
    } else {
      const a = i ^ 0x55
      const exp = (a >> 4) & 7
      const mant = a & 0x0f
      v = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1)
      if (!(a & 0x80)) v = -v
    }
    t[i] = v / 32768
  }
  if (kind === 'alaw') alawTable = t
  else ulawTable = t
  return t
}

/** Returns null if the bytes aren't a WAV container at all. Throws WavError if it's a broken one. */
export function readWav(ab: ArrayBuffer): WavFile | null {
  if (ab.byteLength < 12) return null
  const dv = new DataView(ab)
  const u8 = new Uint8Array(ab)
  const id = (o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
  const riff = id(0)
  if ((riff !== 'RIFF' && riff !== 'RF64' && riff !== 'BW64') || id(8) !== 'WAVE') return null

  const len = ab.byteLength
  let fmt: { tag: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null
  let dataOffset = -1
  let dataLength = 0
  let ds64DataSize: number | null = null
  const cues = new Map<number, number>()
  const labels = new Map<number, string>()
  let bpm: number | null = null
  let timeSig: [number, number] | null = null
  let title: string | null = null
  let artist: string | null = null
  let album: string | null = null
  let software: string | null = null
  let beatMap: BeatMap | null = null
  const text = new TextDecoder('utf-8')
  const str = (from: number, to: number) => {
    let end = from
    while (end < to && u8[end] !== 0) end++
    return text.decode(u8.subarray(from, end)).trim()
  }

  let off = 12
  while (off + 8 <= len) {
    const cid = id(off)
    let size = dv.getUint32(off + 4, true)
    const body = off + 8
    if (cid === 'ds64' && size >= 16) {
      ds64DataSize = Number(dv.getBigUint64(body + 8, true))
    } else if (cid === 'fmt ' && size >= 16) {
      let tag = dv.getUint16(body, true)
      if (tag === 0xfffe && size >= 40) tag = dv.getUint16(body + 24, true) // extensible: real format in SubFormat GUID
      fmt = {
        tag,
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true),
        bits: dv.getUint16(body + 14, true),
      }
    } else if (cid === 'data') {
      if (size === 0xffffffff && ds64DataSize !== null) size = ds64DataSize
      // Size 0 (or past EOF) happens with recorders that never patched the header: use the rest of the file.
      if (size === 0 || body + size > len) size = len - body
      dataOffset = body
      dataLength = size
    } else if (cid === 'cue ' && size >= 4) {
      const count = dv.getUint32(body, true)
      for (let i = 0; i < count && body + 4 + (i + 1) * 24 <= len; i++) {
        const e = body + 4 + i * 24
        cues.set(dv.getUint32(e, true), dv.getUint32(e + 20, true))
      }
    } else if (cid === 'LIST' && size >= 4) {
      const listType = id(body)
      const end = Math.min(len, body + size)
      let o = body + 4
      while (o + 8 <= end) {
        const sid = id(o)
        const ssize = dv.getUint32(o + 4, true)
        const sbody = o + 8
        if (listType === 'adtl' && sid === 'labl' && ssize >= 4) {
          labels.set(dv.getUint32(sbody, true), str(sbody + 4, Math.min(end, sbody + ssize)))
        } else if (listType === 'INFO' && sid === 'INAM') {
          title = str(sbody, Math.min(end, sbody + ssize)) || null
        } else if (listType === 'INFO' && sid === 'IART') {
          artist = str(sbody, Math.min(end, sbody + ssize)) || null
        } else if (listType === 'INFO' && sid === 'IPRD') {
          album = str(sbody, Math.min(end, sbody + ssize)) || null
        } else if (listType === 'INFO' && sid === 'ISFT') {
          software = str(sbody, Math.min(end, sbody + ssize)) || null
        }
        o = sbody + ssize + (ssize & 1)
      }
    } else if (cid === 'bmap' && size > 0) {
      beatMap = parseBeatMap(text.decode(u8.subarray(body, Math.min(len, body + size))).replace(/\0+$/, ''))
    } else if (cid === 'acid' && size >= 24) {
      const tempo = dv.getFloat32(body + 20, true)
      if (tempo >= 20 && tempo <= 400) bpm = Math.round(tempo * 100) / 100
      const den = dv.getUint16(body + 16, true)
      const num = dv.getUint16(body + 18, true)
      if (num >= 1 && num <= 32 && [2, 4, 8, 16].includes(den)) timeSig = [num, den]
    }
    off = body + size + (size & 1)
  }

  if (!fmt) throw new WavError('missing "fmt " chunk')
  if (dataOffset < 0) throw new WavError('missing "data" chunk')
  const { tag, channels, sampleRate, blockAlign } = fmt
  if (!channels || !sampleRate || !blockAlign) throw new WavError('invalid format header')
  const bytesPer = Math.floor(blockAlign / channels)
  const frames = Math.floor(dataLength / blockAlign)

  const markers: WavMarker[] = [...cues.entries()]
    .map(([cueId, frame], i) => ({ time: frame / sampleRate, label: labels.get(cueId) || `Marker ${i + 1}` }))
    .filter((m) => m.time < frames / sampleRate)
    .sort((a, b) => a.time - b.time)
  const meta: WavMeta = { markers, bpm, timeSig, title, artist, album, software, beatMap }

  let encoding: string
  let read: ((o: number) => number) | null = null
  if (tag === 1) {
    encoding = `${bytesPer * 8}-bit PCM`
    if (bytesPer === 1) read = (o) => (u8[o] - 128) / 128
    else if (bytesPer === 2) read = (o) => dv.getInt16(o, true) / 32768
    else if (bytesPer === 3) read = (o) => (((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) << 8) >> 8) / 8388608
    else if (bytesPer === 4) read = (o) => dv.getInt32(o, true) / 2147483648
  } else if (tag === 3) {
    encoding = `${bytesPer * 8}-bit float`
    if (bytesPer === 4) read = (o) => dv.getFloat32(o, true)
    else if (bytesPer === 8) read = (o) => dv.getFloat64(o, true)
  } else if ((tag === 6 || tag === 7) && bytesPer === 1) {
    encoding = tag === 6 ? 'A-law' : 'µ-law'
    const table = g711Table(tag === 6 ? 'alaw' : 'ulaw')
    read = (o) => table[u8[o]]
  } else {
    encoding = FORMAT_NAMES[tag] ?? `format 0x${tag.toString(16).padStart(4, '0')}`
  }

  const reader = read
  const decodeChannels = reader
    ? () => {
        if (frames === 0) throw new WavError('no audio frames')
        return Array.from({ length: channels }, (_, c) => {
          const out = new Float32Array(frames)
          let o = dataOffset + c * bytesPer
          for (let f = 0; f < frames; f++, o += blockAlign) out[f] = reader(o)
          return out
        })
      }
    : null

  return { sampleRate, channels, frames, encoding, meta, decodeChannels }
}
