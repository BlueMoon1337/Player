/**
 * Imports pads into <library>/Pads/<id>/: each zip becomes one pad (its WAVs, wherever they sit in
 * it), and loose WAVs chosen together become one pad. The key each WAV plays comes from its name.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isJunk } from '../src/import/multitracks'
import { PAD_FILE, keyFromFileName, padNameFromFiles } from '../src/import/pads'
import { baseName } from '../src/import/zip'
import type { PadRecord } from '../src/platform/types'
import { openZip } from './importer'
import { type Library, newPadId, uniqueFileName } from './library'

type Failed = { name: string; reason: string }

async function newPad(lib: Library, name: string) {
  const id = newPadId()
  await fs.mkdir(lib.padDir(id), { recursive: true })
  return { version: 1, id, name: name.slice(0, 80), files: [] } as PadRecord
}

/** Saves a pad that got at least one WAV; otherwise removes its folder and says why. */
async function finish(lib: Library, pad: PadRecord, source: string, failed: Failed[]): Promise<PadRecord | null> {
  if (pad.files.length) {
    await lib.savePad(pad)
    return pad
  }
  await fs.rm(lib.padDir(pad.id), { recursive: true, force: true })
  if (!failed.some((f) => f.name === source)) failed.push({ name: source, reason: 'no WAV files in it' })
  return null
}

async function importPadZip(lib: Library, zipPath: string, failed: Failed[]): Promise<PadRecord | null> {
  const source = path.basename(zipPath)
  const zip = await openZip(zipPath)
  try {
    const wavs = zip.entries.filter((e) => PAD_FILE.test(e.name) && !isJunk(e.name)).sort((a, b) => a.name.localeCompare(b.name))
    const zipName = source.replace(/\.zip$/i, '').replace(/[\s_-]+/g, ' ').trim()
    const pad = await newPad(lib, zipName || padNameFromFiles(wavs.map((e) => e.name)))
    const used = new Set<string>(['pad.json'])
    for (const entry of wavs) {
      const name = baseName(entry.name)
      const file = uniqueFileName(name, used)
      try {
        await zip.extract(entry, lib.padPath(pad.id, file))
        pad.files.push({ key: keyFromFileName(name), file })
      } catch (e) {
        failed.push({ name: `${source}: ${name}`, reason: (e as Error).message })
      }
    }
    return finish(lib, pad, source, failed)
  } finally {
    await zip.close()
  }
}

async function importPadFiles(lib: Library, files: string[], failed: Failed[]): Promise<PadRecord | null> {
  const pad = await newPad(lib, padNameFromFiles(files))
  const used = new Set<string>(['pad.json'])
  for (const src of files) {
    const name = path.basename(src)
    const file = uniqueFileName(name, used)
    try {
      await fs.copyFile(src, lib.padPath(pad.id, file))
      pad.files.push({ key: keyFromFileName(name), file })
    } catch {
      failed.push({ name, reason: 'could not copy file' })
    }
  }
  return finish(lib, pad, pad.name, failed)
}

export async function importPads(lib: Library, paths: string[]) {
  const pads: PadRecord[] = []
  const failed: Failed[] = []
  const loose: string[] = []
  for (const p of paths) {
    const stat = await fs.stat(p).catch(() => null)
    if (!stat) {
      failed.push({ name: path.basename(p), reason: 'file not found' })
    } else if (stat.isDirectory()) {
      // A folder (e.g. an unzipped pad): its WAVs are one pad.
      const names = (await fs.readdir(p)).filter((n) => PAD_FILE.test(n) && !isJunk(n)).sort()
      const pad = await importPadFiles(lib, names.map((n) => path.join(p, n)), failed)
      if (pad) {
        pad.name = path.basename(p)
        await lib.savePad(pad)
        pads.push(pad)
      }
    } else if (/\.zip$/i.test(p)) {
      try {
        const pad = await importPadZip(lib, p, failed)
        if (pad) pads.push(pad)
      } catch (e) {
        failed.push({ name: path.basename(p), reason: (e as Error).message })
      }
    } else if (PAD_FILE.test(p)) {
      loose.push(p)
    } else {
      failed.push({ name: path.basename(p), reason: 'not a zip or WAV file' })
    }
  }
  if (loose.length) {
    const pad = await importPadFiles(lib, loose, failed)
    if (pad) pads.push(pad)
  }
  return { pads, failed }
}
