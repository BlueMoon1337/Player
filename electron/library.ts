import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CreatedSong, LibraryData, SongRecord } from '../src/platform/types'

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid song id')
}

/** A bare file name: no separators, no traversal. */
export function assertFileName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Invalid file name')
  }
}

function safeFileName(name: string): string {
  const cleaned = path
    .basename(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
  return cleaned.slice(-120) || 'stem'
}

async function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2))
  await fs.rename(tmp, file)
}

/**
 * The on-disk song library:
 *   <root>/library.json          setlist order
 *   <root>/Songs/<id>/song.json  song settings, sections and stem list
 *   <root>/Songs/<id>/*.wav      the stems (copied in on import)
 */
export class Library {
  constructor(readonly root: string) {}

  private get songsDir() {
    return path.join(this.root, 'Songs')
  }

  songDir(id: string) {
    assertId(id)
    return path.join(this.songsDir, id)
  }

  /** Absolute path of a stem, guaranteed to be inside the song's folder. */
  stemPath(id: string, file: string) {
    assertFileName(file)
    return path.join(this.songDir(id), file)
  }

  async load(): Promise<LibraryData> {
    await fs.mkdir(this.songsDir, { recursive: true })
    const songs: SongRecord[] = []
    for (const entry of await fs.readdir(this.songsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue
      try {
        const rec = JSON.parse(await fs.readFile(path.join(this.songsDir, entry.name, 'song.json'), 'utf8'))
        if (rec?.version === 1 && rec.id === entry.name && Array.isArray(rec.stems)) songs.push(rec)
      } catch {
        // Unfinished import or hand-edited file: skip rather than refuse to start.
      }
    }
    let setlist: string[] | null = null
    try {
      const lib = JSON.parse(await fs.readFile(path.join(this.root, 'library.json'), 'utf8'))
      if (Array.isArray(lib.setlist)) setlist = lib.setlist.filter((x: unknown) => typeof x === 'string')
    } catch {
      /* first run */
    }
    return { root: this.root, songs, setlist }
  }

  async createSong(paths: string[]): Promise<CreatedSong> {
    const songId = `song-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const dir = this.songDir(songId)
    await fs.mkdir(dir, { recursive: true })
    const files: CreatedSong['files'] = []
    const failed: CreatedSong['failed'] = []
    const used = new Set<string>()
    for (const src of paths) {
      const name = path.basename(src)
      let file = safeFileName(name)
      for (let n = 2; used.has(file.toLowerCase()); n++) {
        const ext = path.extname(name)
        file = `${safeFileName(path.basename(name, ext))} ${n}${ext}`
      }
      try {
        await fs.copyFile(src, path.join(dir, file), constants.COPYFILE_EXCL)
        used.add(file.toLowerCase())
        files.push({ name, file })
      } catch (e) {
        failed.push({ name, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : 'could not copy file' })
      }
    }
    return { songId, files, failed }
  }

  async saveSong(rec: SongRecord) {
    assertId(rec?.id)
    if (rec.version !== 1 || !Array.isArray(rec.stems)) throw new Error('Invalid song record')
    for (const s of rec.stems) assertFileName(s.file)
    await writeJsonAtomic(path.join(this.songDir(rec.id), 'song.json'), rec)
  }

  async removeFiles(id: string, files: string[]) {
    for (const f of files) await fs.rm(this.stemPath(id, f), { force: true })
  }

  async saveSetlist(ids: string[]) {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && ID_RE.test(x))) throw new Error('Invalid setlist')
    await fs.mkdir(this.root, { recursive: true })
    await writeJsonAtomic(path.join(this.root, 'library.json'), { version: 1, setlist: ids })
  }
}
