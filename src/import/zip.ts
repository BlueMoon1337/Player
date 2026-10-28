/**
 * Lists a zip archive's files by reading only its directory, so archives of any size (a
 * MultiTracks download can be close to 1 GB) are never loaded into memory. The caller streams
 * each file's bytes from `dataStart` and inflates them if `method` is 8.
 *
 * Like Lumen's reader, it takes Zip64 sizes and offsets wherever an entry says 0xFFFFFFFF, and
 * the Zip64 end record when the plain one overflows.
 */

/** Random access to the archive: a file handle on desktop, Blob.slice in a browser. */
export interface ZipSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export interface ZipEntry {
  name: string
  /** 0 = stored, 8 = deflated. */
  method: number
  compressedSize: number
  size: number
  crc32: number
  localHeaderOffset: number
}

const MAX32 = 0xffffffff

// Code page 437, for names in archives that don't flag UTF-8 and aren't valid UTF-8.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  try {
    // macOS's Archive Utility writes UTF-8 without setting the flag, so try UTF-8 first.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes)
    return Array.from(bytes, (b) => (b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128])).join('')
  }
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

export async function listZip(src: ZipSource): Promise<ZipEntry[]> {
  // End of central directory: the last record, possibly followed by a comment (≤ 64 KB).
  const tailLen = Math.min(src.size, 22 + 65535 + 20)
  const tailStart = src.size - tailLen
  const tail = await src.read(tailStart, tailLen)
  const t = view(tail)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (t.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')

  let count = t.getUint16(eocd + 10, true)
  let cdSize = t.getUint32(eocd + 12, true)
  let cdOffset = t.getUint32(eocd + 16, true)
  if ((count === 0xffff || cdOffset === MAX32 || cdSize === MAX32) && eocd >= 20 && t.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = Number(t.getBigUint64(eocd - 12, true))
    const rec = view(await src.read(z64, 56))
    if (rec.getUint32(0, true) === 0x06064b50) {
      count = Number(rec.getBigUint64(32, true))
      cdSize = Number(rec.getBigUint64(40, true))
      cdOffset = Number(rec.getBigUint64(48, true))
    }
  }
  if (cdOffset + cdSize > src.size) throw new Error('the zip is incomplete (was the download cut short?)')

  const cd = await src.read(cdOffset, cdSize)
  const v = view(cd)
  const entries: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < count && p + 46 <= cd.length && v.getUint32(p, true) === 0x02014b50; n++) {
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const crc32 = v.getUint32(p + 16, true)
    let compressedSize = v.getUint32(p + 20, true)
    let size = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    let localHeaderOffset = v.getUint32(p + 42, true)
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0)
    // Zip64 extra field (0x0001): 8-byte values for each header field that overflowed, in this order.
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
      const tag = v.getUint16(e, true)
      const len = v.getUint16(e + 2, true)
      if (tag === 0x0001) {
        let q = e + 4
        if (size === MAX32) {
          size = Number(v.getBigUint64(q, true))
          q += 8
        }
        if (compressedSize === MAX32) {
          compressedSize = Number(v.getBigUint64(q, true))
          q += 8
        }
        if (localHeaderOffset === MAX32) localHeaderOffset = Number(v.getBigUint64(q, true))
      }
      e += 4 + len
    }
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    entries.push({ name: name.replace(/\\/g, '/'), method, compressedSize, size, crc32, localHeaderOffset })
  }
  return entries
}

/** Where an entry's (compressed) bytes start: after its local header, whose lengths can differ from the directory's. */
export async function dataStart(src: ZipSource, entry: ZipEntry): Promise<number> {
  const h = view(await src.read(entry.localHeaderOffset, 30))
  if (h.getUint32(0, true) !== 0x04034b50) throw new Error(`damaged zip entry: ${entry.name}`)
  return entry.localHeaderOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true)
}

export function checkSupported(entry: ZipEntry) {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${baseName(entry.name)} uses a compression this app can't read (method ${entry.method})`)
  }
}

export const baseName = (p: string) => p.replace(/^.*[\\/]/, '')

let crcTable: Uint32Array | null = null

/** CRC-32 (as zip uses), continued from `crc` across chunks. For runtimes without zlib.crc32. */
export function crc32(chunk: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = ~crc >>> 0
  for (let i = 0; i < chunk.length; i++) c = crcTable[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
