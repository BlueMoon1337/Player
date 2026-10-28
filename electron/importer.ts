// Importing into the library (main process): each zip becomes a song, its stems streamed out,
// inflated and checksum-verified straight into the song folder; each folder becomes a song,
// its stems copied in; loose audio files become one song together. MultiTracks.com downloads
// (zips or the folders they unzip to) bring their cover picture and Ableton set along.

import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { type AbletonSong, parseAbleton } from '../src/import/ableton'
import { isJunk, parseSongName, pickFiles } from '../src/import/multitracks'
import { type ZipEntry, type ZipSource, baseName, checkSupported, dataStart, listZip } from '../src/import/zip'
import type { CreatedSong, ImportProgress } from '../src/platform/types'
import { type Library, newSongId, uniqueFileName } from './library'

export const AUDIO_EXTENSIONS = ['wav', 'wave', 'bwf', 'rf64', 'aif', 'aiff', 'flac', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus']

const isAudio = (p: string) => AUDIO_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase())

type Report = (done: number, total: number, name: string) => void

/** Counts bytes (for progress) and the CRC-32 (to check each unzipped file) as they stream past. */
function meter(onBytes: (n: number) => void) {
  const state = { crc: 0, bytes: 0 }
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      state.crc = zlib.crc32(chunk, state.crc)
      state.bytes += chunk.length
      onBytes(chunk.length)
      done(null, chunk)
    },
  })
  return { stream, state }
}

/** Live sets are gzipped XML. The download's name gives the tempo if the set's can't be read. */
function readAbleton(data: Buffer, sourceName?: string): AbletonSong | null {
  try {
    const xml = (data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data) : data).toString('utf8')
    return xml.includes('<Ableton') ? parseAbleton(xml, sourceName ? parseSongName(sourceName).bpm : null) : null
  } catch {
    return null
  }
}

async function newSongFolder(lib: Library) {
  const songId = newSongId()
  await fs.mkdir(lib.songDir(songId), { recursive: true })
  return songId
}

// ---------------------------------------------------------------------- zip

/**
 * A zip on disk, open: its entries, and extracting one to a file (streamed, and checked against
 * its CRC-32 so a damaged download is caught). Close it when done.
 */
export async function openZip(zipPath: string) {
  const fh = await fs.open(zipPath, 'r')
  const { size } = await fh.stat()
  const src: ZipSource = {
    size,
    read: async (offset, length) => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      return buf.subarray(0, bytesRead)
    },
  }
  let entries: ZipEntry[]
  try {
    entries = await listZip(src)
  } catch (e) {
    await fh.close()
    throw new Error(`can't read the zip: ${(e as Error).message}`)
  }
  const extract = async (entry: ZipEntry, dest: string, onBytes: (n: number) => void = () => {}) => {
    checkSupported(entry)
    if (entry.size === 0) throw new Error('empty file')
    const start = await dataStart(src, entry)
    const m = meter(onBytes)
    const raw = createReadStream(zipPath, { start, end: start + entry.compressedSize - 1, highWaterMark: 1 << 20 })
    const out = createWriteStream(dest)
    try {
      if (entry.method === 8) await pipeline(raw, zlib.createInflateRaw(), m.stream, out)
      else await pipeline(raw, m.stream, out)
    } catch (e) {
      await fs.rm(dest, { force: true })
      throw new Error(`couldn't unzip it (${(e as Error).message})`)
    }
    if (m.state.bytes !== entry.size || m.state.crc >>> 0 !== entry.crc32 >>> 0) {
      await fs.rm(dest, { force: true })
      throw new Error('it is damaged in the zip (checksum mismatch)')
    }
  }
  return { src, entries, extract, close: () => fh.close() }
}

async function importZip(lib: Library, zipPath: string, report: Report): Promise<CreatedSong> {
  const sourceName = path.basename(zipPath).replace(/\.zip$/i, '')
  const zip = await openZip(zipPath)
  const { src, entries } = zip
  try {
    const byName = new Map(entries.map((e) => [e.name, e]))
    const picked = pickFiles(entries.map((e) => e.name))
    if (!picked.stems.length) throw new Error('there are no audio files in the zip')

    const songId = await newSongFolder(lib)
    const dir = lib.songDir(songId)
    const stems = picked.stems.map((n) => byName.get(n)!)
    const art = picked.artwork ? byName.get(picked.artwork) : undefined
    const total = [...stems, ...(art ? [art] : [])].reduce((t, e) => t + e.size, 0)
    let done = 0

    const extract = (entry: ZipEntry, dest: string) =>
      zip.extract(entry, dest, (n) => {
        done += n
        report(done, total, baseName(entry.name))
      })

    const files: CreatedSong['files'] = []
    const failed: CreatedSong['failed'] = []
    const used = new Set<string>()
    for (const entry of stems) {
      const name = baseName(entry.name)
      const file = uniqueFileName(name, used)
      try {
        await extract(entry, path.join(dir, file))
        files.push({ name, file })
      } catch (e) {
        failed.push({ name, reason: (e as Error).message })
      }
    }
    let artwork: string | undefined
    if (art) {
      const file = `artwork${path.extname(art.name).toLowerCase()}`
      try {
        await extract(art, path.join(dir, file))
        artwork = file
      } catch {
        /* a missing cover isn't worth failing over */
      }
    }
    let ableton: AbletonSong | null = null
    const set = picked.ableton ? byName.get(picked.ableton) : undefined
    if (set && set.size < 64 << 20) {
      try {
        checkSupported(set)
        const start = await dataStart(src, set)
        const raw = Buffer.from(await src.read(start, set.compressedSize))
        ableton = readAbleton(set.method === 8 ? zlib.inflateRawSync(raw) : raw, sourceName)
      } catch {
        ableton = null
      }
    }
    return { songId, sourceName, files, failed, artwork, ableton }
  } finally {
    await zip.close()
  }
}

// ------------------------------------------------------------------ folders

async function listFolder(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string, depth: number) => {
    if (depth > 6) return
    for (const ent of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${ent.name}` : ent.name
      if (isJunk(p)) continue
      if (ent.isDirectory()) await walk(p, depth + 1)
      else if (ent.isFile()) out.push(p)
    }
  }
  await walk('', 0)
  return out
}

async function importFolder(lib: Library, folder: string, report: Report): Promise<CreatedSong> {
  const sourceName = path.basename(folder)
  const picked = pickFiles(await listFolder(folder))
  if (!picked.stems.length) throw new Error('there are no audio files in the folder')
  const songId = await newSongFolder(lib)
  const dir = lib.songDir(songId)
  const sizes = await Promise.all(picked.stems.map(async (p) => (await fs.stat(path.join(folder, p))).size))
  const total = sizes.reduce((a, b) => a + b, 0)
  let done = 0
  const files: CreatedSong['files'] = []
  const failed: CreatedSong['failed'] = []
  const used = new Set<string>()
  for (const rel of picked.stems) {
    const name = baseName(rel)
    const file = uniqueFileName(name, used)
    try {
      const m = meter((n) => {
        done += n
        report(done, total, name)
      })
      await pipeline(createReadStream(path.join(folder, rel), { highWaterMark: 1 << 20 }), m.stream, createWriteStream(path.join(dir, file)))
      files.push({ name, file })
    } catch (e) {
      await fs.rm(path.join(dir, file), { force: true })
      failed.push({ name, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : 'could not copy file' })
    }
  }
  let artwork: string | undefined
  if (picked.artwork) {
    const file = `artwork${path.extname(picked.artwork).toLowerCase()}`
    await fs
      .copyFile(path.join(folder, picked.artwork), path.join(dir, file))
      .then(() => (artwork = file))
      .catch(() => {})
  }
  let ableton: AbletonSong | null = null
  if (picked.ableton) {
    ableton = await fs
      .readFile(path.join(folder, picked.ableton))
      .then((data) => readAbleton(data, sourceName))
      .catch(() => null)
  }
  return { songId, sourceName, files, failed, artwork, ableton }
}

// --------------------------------------------------------------- loose files

async function importFiles(lib: Library, paths: string[], report: Report): Promise<CreatedSong> {
  const songId = await newSongFolder(lib)
  const dir = lib.songDir(songId)
  const files: CreatedSong['files'] = []
  const failed: CreatedSong['failed'] = []
  const used = new Set<string>()
  for (const [i, src] of paths.entries()) {
    const name = path.basename(src)
    const file = uniqueFileName(name, used)
    report(i, paths.length, name)
    try {
      await fs.copyFile(src, path.join(dir, file))
      files.push({ name, file })
    } catch (e) {
      failed.push({ name, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : 'could not copy file' })
    }
  }
  return { songId, files, failed }
}

// -------------------------------------------------------------------- entry

/** Imports dropped or picked paths. Each zip and folder is a song; loose audio files are one song. */
export async function importPaths(lib: Library, paths: string[], onProgress: (p: ImportProgress) => void): Promise<CreatedSong[]> {
  type Job = { kind: 'zip' | 'folder'; path: string } | { kind: 'files'; paths: string[] }
  const jobs: Job[] = []
  const loose: string[] = []
  const skipped: CreatedSong['failed'] = []
  for (const p of paths) {
    try {
      const st = await fs.stat(p)
      if (st.isDirectory()) jobs.push({ kind: 'folder', path: p })
      else if (/\.zip$/i.test(p)) jobs.push({ kind: 'zip', path: p })
      else if (isAudio(p)) loose.push(p)
      else skipped.push({ name: path.basename(p), reason: 'not an audio file, zip or folder' })
    } catch {
      skipped.push({ name: path.basename(p), reason: 'file not found' })
    }
  }
  if (loose.length) jobs.push({ kind: 'files', paths: loose })

  const results: CreatedSong[] = []
  for (const [i, job] of jobs.entries()) {
    const source = job.kind === 'files' ? `${job.paths.length} file${job.paths.length === 1 ? '' : 's'}` : path.basename(job.path)
    let last = 0
    const report: Report = (done, total, name) => {
      const now = Date.now()
      if (now - last < 120 && done < total) return
      last = now
      onProgress({ song: i, songs: jobs.length, source, name, done, total })
    }
    try {
      if (job.kind === 'files') results.push(await importFiles(lib, job.paths, report))
      else if (job.kind === 'zip') results.push(await importZip(lib, job.path, report))
      else results.push(await importFolder(lib, job.path, report))
    } catch (e) {
      results.push({ songId: '', sourceName: source, files: [], failed: [{ name: source, reason: (e as Error).message }] })
    }
  }
  if (skipped.length) {
    if (results.length) results[0].failed.push(...skipped)
    else results.push({ songId: '', files: [], failed: skipped })
  }
  return results
}

