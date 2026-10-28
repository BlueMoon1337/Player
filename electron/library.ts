import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LibraryData, LibraryState, SetlistRecord, SongRecord } from '../src/platform/types'

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

export function newSongId() {
  return `song-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** A file name that's safe on every OS and not yet used in this song folder (case-insensitively). */
export function uniqueFileName(name: string, used: Set<string>): string {
  const ext = path.extname(name)
  let file = safeFileName(name)
  for (let n = 2; used.has(file.toLowerCase()); n++) file = `${safeFileName(path.basename(name, ext))} ${n}${ext}`
  used.add(file.toLowerCase())
  return file
}

export function safeFileName(name: string): string {
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

/** Reads library.json (version 1 had a single setlist), keeping only well-formed entries. */
function parseLibraryFile(raw: unknown): LibraryState | null {
  const lib = raw as Record<string, unknown> | null
  if (!lib || typeof lib !== 'object') return null
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)) : [])
  if (lib.version === 1) {
    const songs = ids(lib.setlist)
    return { setlists: [{ id: 'setlist-1', name: 'Setlist', songs }], currentSetlist: 'setlist-1', hiddenDemos: [] }
  }
  if (lib.version !== 2 || !Array.isArray(lib.setlists)) return null
  const setlists: SetlistRecord[] = lib.setlists
    .filter((s: Record<string, unknown>) => s && typeof s.id === 'string' && ID_RE.test(s.id) && typeof s.name === 'string')
    .map((s: Record<string, unknown>) => ({ id: s.id as string, name: (s.name as string).slice(0, 80), songs: ids(s.songs) }))
  const current = typeof lib.currentSetlist === 'string' && setlists.some((s) => s.id === lib.currentSetlist) ? lib.currentSetlist : null
  return { setlists, currentSetlist: current, hiddenDemos: ids(lib.hiddenDemos) }
}

/**
 * The on-disk song library:
 *   <root>/library.json          setlists, the current one, hidden demo songs
 *   <root>/Songs/<id>/song.json  song settings, sections and stem list
 *   <root>/Songs/<id>/*.wav      the stems (copied in on import)
 *   <root>/.Trash/<id>/          songs deleted this session, so Undo can bring them back;
 *                                they go to the system trash the next time Player starts
 */
export class Library {
  constructor(readonly root: string) {}

  private get songsDir() {
    return path.join(this.root, 'Songs')
  }

  get trashDir() {
    return path.join(this.root, '.Trash')
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
    let state: LibraryState | null = null
    try {
      state = parseLibraryFile(JSON.parse(await fs.readFile(path.join(this.root, 'library.json'), 'utf8')))
    } catch {
      /* first run */
    }
    return { root: this.root, songs, state }
  }

  async saveSong(rec: SongRecord) {
    assertId(rec?.id)
    if (rec.version !== 1 || !Array.isArray(rec.stems)) throw new Error('Invalid song record')
    for (const s of rec.stems) assertFileName(s.file)
    if (rec.artwork !== undefined) assertFileName(rec.artwork)
    await writeJsonAtomic(path.join(this.songDir(rec.id), 'song.json'), rec)
  }

  async removeFiles(id: string, files: string[]) {
    for (const f of files) await fs.rm(this.stemPath(id, f), { force: true })
  }

  async saveState(state: LibraryState) {
    const clean = parseLibraryFile({ version: 2, ...state })
    if (!clean) throw new Error('Invalid library state')
    await fs.mkdir(this.root, { recursive: true })
    await writeJsonAtomic(path.join(this.root, 'library.json'), { version: 2, ...clean })
  }

  /** Deletes a song so that it can still be restored until the next launch. */
  async deleteSong(id: string) {
    const dest = path.join(this.trashDir, id)
    await fs.mkdir(this.trashDir, { recursive: true })
    await fs.rm(dest, { recursive: true, force: true })
    await fs.rename(this.songDir(id), dest)
  }

  /** Brings back a song deleted this session (Undo). */
  async restoreSong(id: string): Promise<SongRecord> {
    assertId(id)
    await fs.rename(path.join(this.trashDir, id), this.songDir(id))
    return JSON.parse(await fs.readFile(path.join(this.songDir(id), 'song.json'), 'utf8'))
  }

  /** Song folders deleted in an earlier session, ready to be emptied out. */
  async trashedSongs(): Promise<string[]> {
    try {
      return (await fs.readdir(this.trashDir)).map((n) => path.join(this.trashDir, n))
    } catch {
      return []
    }
  }
}
