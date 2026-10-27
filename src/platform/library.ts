import { decodeAudio } from '../audio/decoder'
import { type StemSource, type ImportResult, importStems } from '../audio/importer'
import { songArtwork } from '../audio/synth'
import type { Song, Stem } from '../audio/types'
import { type DesktopAPI, type SongRecord, mediaUrl } from './types'

export function recordFromSong(song: Song): SongRecord {
  const stems = song.stems.length
    ? song.stems.filter((s) => s.file).map((s) => ({ id: s.id, name: s.name, file: s.file! }))
    : (song.stemFiles ?? [])
  return {
    version: 1,
    id: song.id,
    title: song.title,
    key: song.key,
    bpm: song.bpm,
    timeSig: song.timeSig,
    clickOffset: song.clickOffset,
    duration: song.duration,
    sections: song.sections,
    stems,
  }
}

export function songFromRecord(rec: SongRecord): Song {
  return {
    id: rec.id,
    title: rec.title,
    key: rec.key,
    bpm: rec.bpm,
    timeSig: rec.timeSig,
    clickOffset: rec.clickOffset,
    duration: rec.duration,
    sections: rec.sections,
    stems: [],
    stemFiles: rec.stems,
    artwork: songArtwork(rec.title),
    source: 'library',
  }
}

/** Decodes a library song's stems from disk. Stems that fail are reported, not fatal. */
export async function loadSongStems(
  ctx: AudioContext,
  song: Song,
  onProgress: (done: number, total: number, name: string) => void,
): Promise<{ stems: Stem[]; missing: string[] }> {
  const files = song.stemFiles ?? []
  const stems: Stem[] = []
  const missing: string[] = []
  for (const [i, f] of files.entries()) {
    onProgress(i, files.length, f.name)
    try {
      const { buffer } = await decodeAudio(ctx, mediaUrl(song.id, f.file))
      stems.push({ id: f.id, name: f.name, buffer, file: f.file })
    } catch (e) {
      missing.push(`${f.file} (${(e as Error).message})`)
    }
  }
  return { stems, missing }
}

/**
 * Desktop import: copies the files into a new library song folder, decodes them from
 * there, saves song.json and cleans up anything that couldn't be used.
 */
export async function importIntoLibrary(
  api: DesktopAPI,
  ctx: AudioContext,
  paths: string[],
  onProgress: (done: number, total: number, name: string) => void,
): Promise<ImportResult> {
  const created = await api.library.createSong(paths)
  const sources: StemSource[] = created.files.map((f) => ({
    name: f.name,
    file: f.file,
    input: mediaUrl(created.songId, f.file),
  }))
  if (sources.length === 0) {
    await api.library.deleteSong(created.songId)
    throw new Error(created.failed.map((f) => `${f.name}: ${f.reason}`).join('; ') || 'No audio files found')
  }
  let result: ImportResult
  try {
    result = await importStems(ctx, sources, { songId: created.songId, source: 'library', onProgress })
  } catch (e) {
    await api.library.deleteSong(created.songId)
    throw e
  }
  result.skipped.push(...created.failed)
  if (result.skippedFiles.length) await api.library.removeFiles(created.songId, result.skippedFiles)
  result.song.stemFiles = recordFromSong(result.song).stems
  await api.library.saveSong(recordFromSong(result.song))
  return result
}
