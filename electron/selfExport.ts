/**
 * Export Player (File ▸ Export Player, Settings ▸ About): a copy of the installed app, to take to
 * another computer (a backup laptop at church, say) without going online.
 *
 * - macOS: a disk image holding Player.app and an Applications shortcut to drag it onto, made
 *   with hdiutil; or a zip, made with ditto (as the updater unpacks one), which keeps the app's
 *   symbolic links, permissions and ad-hoc signature intact.
 * - Windows: a zip of the installed Player folder; unzip it anywhere and run Player.exe.
 * - Linux: the AppImage itself, or a zip of it (keeping it executable).
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { app } from 'electron'

import type { ExportFormat } from '../src/platform/types'

export type { ExportFormat }

/** What this copy of Player can be exported as; nothing when it isn't a packaged build. */
export function exportFormats(): ExportFormat[] {
  if (!app.isPackaged) return []
  if (process.platform === 'darwin') return ['dmg', 'zip']
  if (process.platform === 'win32') return ['zip']
  if (process.platform === 'linux' && process.env.APPIMAGE) return ['appimage', 'zip']
  return []
}

/** The file name the save dialog suggests, and its type. */
export function exportFile(format: ExportFormat): { name: string; filter: Electron.FileFilter } {
  const v = app.getVersion()
  const system = { darwin: 'mac', win32: 'win-x64', linux: 'linux' }[process.platform as string] ?? process.platform
  if (format === 'dmg') return { name: `Player-${v}-${system}.dmg`, filter: { name: 'Disk Image', extensions: ['dmg'] } }
  if (format === 'appimage') return { name: `Player-${v}.AppImage`, filter: { name: 'AppImage', extensions: ['AppImage'] } }
  return { name: `Player-${v}-${system}.zip`, filter: { name: 'Zip Archive', extensions: ['zip'] } }
}

/** macOS: …/Player.app/Contents/MacOS/Player → …/Player.app */
const macBundle = () => path.resolve(process.execPath, '..', '..', '..')

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed${err.trim() ? `: ${err.trim().split('\n').pop()}` : ` (${code})`}`)),
    )
  })
}

/**
 * Writes Player to `dest`. `progress` gets the share done (0..1) where it can be told, or null
 * while a system tool (hdiutil, ditto) works.
 */
export async function exportApp(format: ExportFormat, dest: string, progress: (done: number | null) => void) {
  if (!exportFormats().includes(format)) throw new Error('Player can’t be exported in that format here.')
  // Written next to the destination, then moved into place, so a failure leaves nothing half-made.
  const partial = `${dest}.partial`
  await fsp.rm(partial, { recursive: true, force: true })
  try {
    if (process.platform === 'darwin') {
      progress(null)
      const bundle = macBundle()
      if (format === 'zip') await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, partial])
      else await makeDmg(bundle, partial)
    } else if (process.platform === 'win32') {
      const dir = path.dirname(process.execPath)
      // The uninstaller belongs to the installed copy, not to one unzipped somewhere else.
      await writeZip(partial, [{ from: dir, as: 'Player', skip: (rel) => /^uninstall .*\.exe$/i.test(rel) }], progress)
    } else {
      const image = process.env.APPIMAGE!
      if (format === 'appimage') {
        progress(null)
        await fsp.copyFile(image, partial)
        await fsp.chmod(partial, 0o755)
      } else {
        await writeZip(partial, [{ from: image, as: path.basename(image) }], progress)
      }
    }
    await fsp.rm(dest, { recursive: true, force: true })
    await fsp.rename(partial, dest)
  } catch (e) {
    await fsp.rm(partial, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

/** A compressed disk image: Player.app and an Applications shortcut, as apps are handed out. */
async function makeDmg(bundle: string, dest: string) {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'player-dmg-'))
  try {
    await run('/usr/bin/ditto', [bundle, path.join(stage, path.basename(bundle))])
    await fsp.symlink('/Applications', path.join(stage, 'Applications'))
    await run('/usr/bin/hdiutil', [
      'create',
      '-volname',
      `Player ${app.getVersion()}`,
      '-srcfolder',
      stage,
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      '-ov',
      // hdiutil names the file itself: .dmg on the end, renamed afterwards.
      `${dest}.dmg`,
    ])
    await fsp.rename(`${dest}.dmg`, dest)
  } finally {
    await fsp.rm(stage, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------- zip

interface ZipSource {
  /** A file or a folder on disk. */
  from: string
  /** Its path inside the zip. */
  as: string
  /** Leaves out files (paths relative to `from`, with forward slashes). */
  skip?: (rel: string) => boolean
}

interface Entry {
  name: string
  file: string | null
  link: string | null
  mode: number
  mtime: Date
  size: number
}

async function collect(src: ZipSource): Promise<Entry[]> {
  const out: Entry[] = []
  const walk = async (abs: string, rel: string) => {
    const st = await fsp.lstat(abs)
    const name = rel ? `${src.as}/${rel}` : src.as
    if (st.isSymbolicLink()) {
      out.push({ name, file: null, link: await fsp.readlink(abs), mode: st.mode, mtime: st.mtime, size: 0 })
    } else if (st.isDirectory()) {
      out.push({ name: `${name}/`, file: null, link: null, mode: st.mode, mtime: st.mtime, size: 0 })
      for (const child of (await fsp.readdir(abs)).sort()) {
        const childRel = rel ? `${rel}/${child}` : child
        if (src.skip?.(childRel)) continue
        await walk(path.join(abs, child), childRel)
      }
    } else if (st.isFile()) {
      out.push({ name, file: abs, link: null, mode: st.mode, mtime: st.mtime, size: st.size })
    }
  }
  await walk(src.from, '')
  return out
}

function dosTime(d: Date): [number, number] {
  const year = Math.max(1980, d.getFullYear())
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ]
}

/**
 * A zip of files and folders, deflated, keeping each file's Unix permissions (an AppImage stays
 * executable) and symbolic links. Plain zip, not Zip64: up to 4 GB and 65,535 entries, plenty
 * for an app.
 */
export async function writeZip(dest: string, sources: ZipSource[], progress: (done: number) => void = () => {}) {
  const entries = (await Promise.all(sources.map(collect))).flat()
  if (entries.length > 0xffff) throw new Error('Too many files for a zip.')
  const total = entries.reduce((t, e) => t + e.size, 0) || 1
  let done = 0
  const fd = await fsp.open(dest, 'w')
  let offset = 0
  const write = async (b: Buffer) => {
    await fd.write(b)
    offset += b.length
    if (offset > 0xffffffff) throw new Error('Player is too big to zip (over 4 GB).')
  }
  const central: Buffer[] = []
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8')
      const raw = e.file ? await fsp.readFile(e.file) : e.link !== null ? Buffer.from(e.link, 'utf8') : Buffer.alloc(0)
      const crc = zlib.crc32(raw)
      let data = raw
      let method = 0
      if (e.file && raw.length > 0) {
        const deflated = await new Promise<Buffer>((res, rej) => zlib.deflateRaw(raw, { level: 6 }, (err, b) => (err ? rej(err) : res(b))))
        if (deflated.length < raw.length) {
          data = deflated
          method = 8
        }
      }
      const [time, date] = dosTime(e.mtime)
      const at = offset
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(0x0800, 6) // names are UTF-8
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      await write(Buffer.concat([local, name]))
      await write(data)
      // The central directory: made on Unix (3), so the mode in the external attributes counts.
      const mode = e.link !== null ? 0o120777 : e.name.endsWith('/') ? 0o40755 : 0o100000 | (e.mode & 0o777)
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE((3 << 8) | 20, 4)
      c.writeUInt16LE(20, 6)
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(method, 10)
      c.writeUInt16LE(time, 12)
      c.writeUInt16LE(date, 14)
      c.writeUInt32LE(crc, 16)
      c.writeUInt32LE(data.length, 20)
      c.writeUInt32LE(raw.length, 24)
      c.writeUInt16LE(name.length, 28)
      c.writeUInt32LE(((mode << 16) | (e.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38)
      c.writeUInt32LE(at, 42)
      central.push(Buffer.concat([c, name]))
      done += e.size
      progress(done / total)
    }
    const start = offset
    for (const c of central) await write(c)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(offset - start, 12)
    end.writeUInt32LE(start, 16)
    await write(end)
  } finally {
    await fd.close()
  }
}
