import { DECODERS, decodeAudio, mapLimit } from '../audio/decoder'
import { type ImportResult, type StemSource, importStems } from '../audio/importer'
import { songArtwork } from '../audio/synth'
import type { Song, Stem } from '../audio/types'
import { parseSongName } from '../import/multitracks'
import { type CreatedSong, type DesktopAPI, type SongRecord, mediaUrl } from './types'

export function recordFromSong(song: Song): SongRecord {
  const stems = song.stems.length
    ? song.stems.filter((s) => s.file).map((s) => ({ id: s.id, name: s.name, file: s.file! }))
    : (song.stemFiles ?? [])
  // A cover saved in the song folder is referenced by its file name.
  const prefix = mediaUrl(song.id, '')
  const artwork = song.artwork.startsWith(prefix) ? decodeURIComponent(song.artwork.slice(prefix.length)) : undefined
  return {
    version: 1,
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    added: song.added,
    key: song.key,
    bpm: song.bpm,
    timeSig: song.timeSig,
    clickOffset: song.clickOffset,
    duration: song.duration,
    sections: song.sections,
    stems,
    artwork,
    clickStem: song.clickStem ?? null,
  }
}

export function songFromRecord(rec: SongRecord): Song {
  return {
    id: rec.id,
    title: rec.title,
    artist: rec.artist,
    album: rec.album,
    added: rec.added,
    key: rec.key,
    bpm: rec.bpm,
    timeSig: rec.timeSig,
    clickOffset: rec.clickOffset,
    duration: rec.duration,
    sections: rec.sections,
    stems: [],
    stemFiles: rec.stems,
    clickStem: rec.clickStem ?? null,
    artwork: rec.artwork ? mediaUrl(rec.id, rec.artwork) : songArtwork(rec.title),
    source: 'library',
  }
}

/** Decodes a library song's stems from disk, several at once. Stems that fail are reported, not fatal. */
export async function loadSongStems(
  ctx: AudioContext,
  song: Song,
  onProgress: (done: number, total: number, name: string) => void,
): Promise<{ stems: Stem[]; missing: string[] }> {
  const files = song.stemFiles ?? []
  const missing: string[] = []
  let finished = 0
  if (files.length) onProgress(0, files.length, files[0].name)
  const loaded = await mapLimit(files, DECODERS, async (f) => {
    try {
      const { buffer } = await decodeAudio(ctx, mediaUrl(song.id, f.file))
      return { id: f.id, name: f.name, buffer, file: f.file } as Stem
    } catch (e) {
      missing.push(`${f.file} (${(e as Error).message})`)
      return null
    } finally {
      finished++
      if (finished < files.length) onProgress(finished, files.length, files[finished]?.name ?? f.name)
    }
  })
  return { stems: loaded.filter((s): s is Stem => s !== null), missing }
}

export interface LibraryImport {
  results: ImportResult[]
  /** Zips or folders that produced no song, with why. */
  failed: { name: string; reason: string }[]
}

/** Decodes one song the main process has put into the library, then saves its song.json. */
async function finishSong(api: DesktopAPI, ctx: AudioContext, created: CreatedSong, onProgress: (d: number, t: number, n: string) => void) {
  const sources: StemSource[] = created.files.map((f) => ({ name: f.name, file: f.file, input: mediaUrl(created.songId, f.file) }))
  let result: ImportResult
  try {
    result = await importStems(ctx, sources, {
      songId: created.songId,
      source: 'library',
      onProgress,
      meta: {
        name: created.sourceName ? parseSongName(created.sourceName) : undefined,
        ableton: created.ableton,
        artwork: created.artwork ? mediaUrl(created.songId, created.artwork) : undefined,
      },
    })
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

/**
 * Desktop import: the main process copies (or unzips) each zip, folder or set of files into a
 * new song folder; each is then decoded from there and saved, and anything unusable is cleaned up.
 */
export async function importIntoLibrary(
  api: DesktopAPI,
  ctx: AudioContext,
  paths: string[],
  onStatus: (text: string) => void,
): Promise<LibraryImport> {
  const stop = api.library.onImportProgress((p) => {
    const pct = p.total ? ` ${Math.floor((100 * p.done) / p.total)}%` : ''
    const which = p.songs > 1 ? ` (${p.song + 1} of ${p.songs})` : ''
    onStatus(`Copying ${p.source}${which}: ${p.name}${pct}`)
  })
  let created: CreatedSong[]
  try {
    created = await api.library.importPaths(paths)
  } finally {
    stop()
  }
  const results: ImportResult[] = []
  const failed: LibraryImport['failed'] = []
  for (const [i, c] of created.entries()) {
    const label = c.sourceName ?? 'files'
    if (!c.songId) {
      failed.push(...c.failed)
      continue
    }
    try {
      const which = created.length > 1 ? ` (${i + 1} of ${created.length})` : ''
      results.push(
        await finishSong(api, ctx, c, (d, t, n) => onStatus(`Decoding ${label}${which}: ${t > 1 ? `${d + 1} of ${t}, ` : ''}${n}`)),
      )
    } catch (e) {
      failed.push({ name: label, reason: (e as Error).message })
    }
  }
  return { results, failed }
}
