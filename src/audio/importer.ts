import { type AudioInput, decodeAudio } from './decoder'
import { songArtwork } from './synth'
import { type Section, type Song, type Stem, uid } from './types'
import type { WavMeta } from './wav'

const AUDIO_EXT = /\.(wav|wave|bwf|rf64|mp3|m4a|aac|ogg|oga|flac|aif|aiff|webm|opus)$/i

export function isAudioName(name: string) {
  return AUDIO_EXT.test(name)
}

export function isAudioFile(f: File) {
  return f.type.startsWith('audio/') || isAudioName(f.name)
}

function stemName(fileName: string, prefix: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  const trimmed = base.slice(prefix.length).replace(/^[\s_\-.]+/, '')
  return trimmed || base
}

function commonPrefix(names: string[]): string {
  if (names.length < 2) return ''
  let p = names[0]
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1)
  // Only keep it if it ends on a word boundary.
  const m = p.match(/^(.*?)[\s_\-.]*$/)
  return m && /[\s_\-.]$/.test(p) ? p : m ? m[1] : ''
}

/** One stem to import: its original file name, and where to read it from. */
export interface StemSource {
  name: string
  /** File name in the song's library folder, when the stem lives on disk (desktop). */
  file?: string
  input: AudioInput
}

export function fileSource(f: File): StemSource {
  return { name: f.name, input: f }
}

export interface SkippedFile {
  name: string
  reason: string
}

export interface ImportResult {
  song: Song
  skipped: SkippedFile[]
  /** Library files that couldn't be decoded, so the caller can delete them. */
  skippedFiles: string[]
  /** Notes about what was picked up from file metadata, for the UI to show. */
  notes: string[]
}

interface Decoded {
  source: StemSource
  buffer: AudioBuffer
  meta: WavMeta | null
}

function sectionsFromMarkers(meta: WavMeta, duration: number): Section[] {
  const out: Section[] = []
  for (const m of meta.markers) {
    if (m.time >= duration) continue
    // Drop markers that sit on top of each other.
    if (out.length && m.time - out[out.length - 1].start < 0.05) continue
    out.push({ id: uid('sec'), name: m.label.slice(0, 32), start: m.time })
  }
  if (!out.length || out[0].start > 0.05) out.unshift({ id: uid('sec'), name: out.length ? 'Start' : 'Song', start: 0 })
  out[0].start = 0
  return out
}

/** Decodes a batch of stems into a new song with one channel per file. */
export async function importStems(
  ctx: AudioContext,
  sources: StemSource[],
  opts: {
    songId?: string
    source?: Song['source']
    onProgress?: (done: number, total: number, name: string) => void
  } = {},
): Promise<ImportResult> {
  const audio = sources.filter((s) => isAudioName(s.name)).sort((a, b) => a.name.localeCompare(b.name))
  const skipped: SkippedFile[] = sources
    .filter((s) => !isAudioName(s.name))
    .map((s) => ({ name: s.name, reason: 'not an audio file' }))
  const skippedFiles = sources.filter((s) => !isAudioName(s.name) && s.file).map((s) => s.file!)
  if (audio.length === 0) throw new Error('No audio files found')

  const decoded: Decoded[] = []
  // One file at a time keeps peak memory down with long multi-channel stems.
  for (const [i, src] of audio.entries()) {
    opts.onProgress?.(i, audio.length, src.name)
    try {
      const { buffer, meta } = await decodeAudio(ctx, src.input)
      decoded.push({ source: src, buffer, meta })
    } catch (e) {
      skipped.push({ name: src.name, reason: (e as Error).message })
      if (src.file) skippedFiles.push(src.file)
    }
  }
  if (decoded.length === 0) {
    throw new Error(skipped.map((s) => `${s.name}: ${s.reason}`).join('; '))
  }

  const names = decoded.map((d) => d.source.name.replace(/\.[^.]+$/, ''))
  const prefix = commonPrefix(names)
  const stems: Stem[] = decoded.map((d) => ({
    id: uid('stem'),
    name: stemName(d.source.name, prefix).slice(0, 12),
    buffer: d.buffer,
    file: d.source.file,
  }))
  const duration = Math.max(...stems.map((s) => s.buffer.duration))

  // Metadata: markers from whichever stem carries the most (often the guide), tempo from the first that has one.
  const metas = decoded.map((d) => d.meta).filter((m): m is WavMeta => m !== null)
  const markerSource = metas.reduce<WavMeta | null>(
    (best, m) => (m.markers.length > (best?.markers.length ?? 0) ? m : best),
    null,
  )
  const bpm = metas.find((m) => m.bpm)?.bpm ?? null
  const timeSig = metas.find((m) => m.timeSig)?.timeSig ?? null
  const metaTitle = metas.find((m) => m.title)?.title ?? null

  const notes: string[] = []
  if (markerSource) notes.push(`${markerSource.markers.length} section markers`)
  if (bpm) notes.push(`${bpm} BPM`)
  if (timeSig) notes.push(`${timeSig[0]}/${timeSig[1]}`)

  const title =
    metaTitle || prefix.replace(/[\s_\-.]+$/, '') || (decoded.length === 1 ? names[0] : 'Imported Song')
  const song: Song = {
    id: opts.songId ?? uid('song'),
    title,
    key: 'C',
    bpm: bpm ?? 120,
    timeSig: timeSig ?? [4, 4],
    clickOffset: 0,
    duration,
    sections: markerSource
      ? sectionsFromMarkers(markerSource, duration)
      : [{ id: uid('sec'), name: 'Song', start: 0 }],
    stems,
    artwork: songArtwork(title),
    source: opts.source ?? 'user',
  }
  return { song, skipped, skippedFiles, notes }
}
