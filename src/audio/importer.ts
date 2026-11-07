import type { AbletonSong } from '../import/ableton'
import { type SongName, isClickStem } from '../import/multitracks'
import { clickSamples, detectClickMap, songTiming } from './clickmap'
import { type AudioInput, DECODERS, decodeAudio, isOutOfMemory, mapLimit } from './decoder'
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
  /** The bytes, or a function that produces them when it's this stem's turn (e.g. unzipping). */
  input: AudioInput | (() => Promise<AudioInput>)
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
  /** Something the UI should point out, e.g. that no sections were found and why. */
  warnings: string[]
}

interface Decoded {
  source: StemSource
  /** Size of the file, when it was handed over as bytes (not a URL). */
  bytes: number | null
  buffer: AudioBuffer
  meta: WavMeta | null
}

function sectionsFromMarkers(meta: { markers: { time: number; label: string }[] }, duration: number): Section[] {
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
    /** What's known from outside the audio: a MultiTracks name, its Ableton set, a cover picture URL. */
    meta?: { name?: SongName; ableton?: AbletonSong | null; artwork?: string }
  } = {},
): Promise<ImportResult> {
  const audio = sources.filter((s) => isAudioName(s.name)).sort((a, b) => a.name.localeCompare(b.name))
  const skipped: SkippedFile[] = sources
    .filter((s) => !isAudioName(s.name))
    .map((s) => ({ name: s.name, reason: 'not an audio file' }))
  const skippedFiles = sources.filter((s) => !isAudioName(s.name) && s.file).map((s) => s.file!)
  if (audio.length === 0) throw new Error('No audio files found')

  // A few at a time: as fast as the decoders allow, without holding every file in memory at once.
  const outOfMemory: string[] = []
  let finished = 0
  opts.onProgress?.(0, audio.length, audio[0].name)
  const results = await mapLimit(audio, DECODERS, async (src) => {
    try {
      const input = typeof src.input === 'function' ? await src.input() : src.input
      const bytes = typeof input === 'string' ? null : input instanceof Blob ? input.size : input.byteLength
      const { buffer, meta } = await decodeAudio(ctx, input)
      return { source: src, bytes, buffer, meta } as Decoded
    } catch (e) {
      // Out of memory says nothing about the file: it isn't skipped (or deleted), the import stops.
      if (isOutOfMemory(e)) {
        outOfMemory.push(src.name)
        return null
      }
      skipped.push({ name: src.name, reason: (e as Error).message })
      if (src.file) skippedFiles.push(src.file)
      return null
    } finally {
      finished++
      if (finished < audio.length) opts.onProgress?.(finished, audio.length, audio[finished]?.name ?? src.name)
    }
  })
  if (outOfMemory.length) {
    throw new Error(
      `there wasn't enough memory to read ${outOfMemory.length} of its ${audio.length} stems. Close other apps (or songs) and import it again.`,
    )
  }
  const decoded = results.filter((d): d is Decoded => d !== null)
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
  const metaArtist = metas.find((m) => m.artist)?.artist ?? undefined
  const metaAlbum = metas.find((m) => m.album)?.album ?? undefined
  // KeyFinder (github.com/BlueMoon1337/key-finder) names its exports like MultiTracks downloads
  // but with the artist where MultiTracks put the album, and says so in its WAVs (ISFT).
  const fromKeyFinder = metas.some((m) => m.software === 'KeyFinder')

  // What's known from outside the audio wins: a MultiTracks name (title, album, key, BPM),
  // then its Ableton set (sections, time signature), then what the WAV files carry.
  const name = opts.meta?.name
  const nameArtist = fromKeyFinder && name?.album && name.album !== 'KeyFinder' ? name.album : undefined
  const artist = metaArtist ?? nameArtist
  const album = fromKeyFinder ? metaAlbum : (name?.album ?? metaAlbum)
  const set = opts.meta?.ableton
  const setMarkers = set?.markers.length ? set : null
  const finalBpm = name?.bpm ?? set?.bpm ?? bpm ?? 120
  const finalSig = set?.timeSig ?? timeSig ?? [4, 4]
  const clickStem = stems.find((s) => isClickStem(s.name))

  // Tempo and time signature changes, and where bar 1 falls: KeyFinder's beat map (exact), else
  // the Ableton set's automation, else what the click stem plays (a set is trusted over its click).
  const beatMap = metas.find((m) => m.beatMap)?.beatMap ?? null
  let timing: ReturnType<typeof songTiming> = { clickOffset: 0 }
  let timingFrom = ''
  if (beatMap) {
    timing = {
      clickOffset: beatMap.offset,
      bpm: beatMap.tempos[0].bpm,
      timeSig: beatMap.meters[0]?.timeSig,
      tempos: beatMap.tempos.length > 1 ? beatMap.tempos : undefined,
      meters: beatMap.meters.length > 1 ? beatMap.meters : undefined,
    }
    timingFrom = 'KeyFinder'
  } else if (set && (set.tempos.length > 1 || set.meters.length > 1)) {
    timing = {
      clickOffset: 0,
      bpm: set.tempos.length > 1 ? set.tempos[0].bpm : undefined,
      timeSig: set.meters[0]?.timeSig,
      tempos: set.tempos.length > 1 ? set.tempos : undefined,
      meters: set.meters.length > 1 ? set.meters : undefined,
    }
    timingFrom = 'the Ableton set'
  } else if (clickStem && !set) {
    const map = detectClickMap(clickSamples(clickStem.buffer), clickStem.buffer.sampleRate, finalSig[1])
    if (map) {
      timing = songTiming(map, name?.bpm ?? bpm)
      timingFrom = `its ${clickStem.name}`
    }
  }

  const notes: string[] = []
  if (name?.album) {
    notes.push(fromKeyFinder ? `title, ${artist ? 'artist, ' : ''}key and tempo from KeyFinder` : `title, album, key and tempo from the name`)
  }
  // Counted as they'll appear: a marker past the end of the audio is dropped.
  const within = (m: { markers: { time: number }[] }) => m.markers.filter((x) => x.time < duration).length
  if (setMarkers) notes.push(`${within(setMarkers)} sections from the Ableton set`)
  else if (markerSource) notes.push(`${within(markerSource)} section markers`)
  if (!name?.bpm && (set?.bpm || bpm)) notes.push(`${finalBpm} BPM`)
  if (timeSig && !set?.timeSig) notes.push(`${timeSig[0]}/${timeSig[1]}`)
  if (clickStem) notes.push(`its ${clickStem.name} as the click`)
  const changes = [
    timing.tempos && `${timing.tempos.length - 1} tempo change${timing.tempos.length === 2 ? '' : 's'}`,
    timing.meters && `${timing.meters.length - 1} time signature change${timing.meters.length === 2 ? '' : 's'}`,
  ].filter(Boolean)
  if (changes.length) notes.push(`${changes.join(' and ')} from ${timingFrom}`)
  else if (timing.timeSig && timingFrom && timing.timeSig.join('/') !== finalSig.join('/')) notes.push(`${timing.timeSig.join('/')} from ${timingFrom}`)
  const warnings: string[] = []
  if (!setMarkers && !markerSource && (set || name?.album)) {
    warnings.push(
      set
        ? 'No sections found: its Ableton set has no locators or clips named like sections. Add them in the song map (EDIT).'
        : fromKeyFinder
          ? 'No sections found: KeyFinder marks only key changes, and this song stays in one key. Add them in the song map (EDIT).'
          : 'No sections found: there’s no Ableton set (.als) in it. Add them in the song map (EDIT).',
    )
  }

  const title =
    (name?.album ? name.title : null) ||
    metaTitle ||
    prefix.replace(/[\s_\-.]+$/, '') ||
    name?.title ||
    (decoded.length === 1 ? names[0] : 'Imported Song')
  const song: Song = {
    id: opts.songId ?? uid('song'),
    title,
    artist,
    album,
    added: Date.now(),
    key: name?.key ?? 'C',
    bpm: timing.bpm ?? finalBpm,
    timeSig: timing.timeSig ?? finalSig,
    clickOffset: timing.clickOffset,
    tempos: timing.tempos,
    meters: timing.meters,
    duration,
    sections: setMarkers
      ? sectionsFromMarkers(setMarkers, duration)
      : markerSource
        ? sectionsFromMarkers(markerSource, duration)
        : [{ id: uid('sec'), name: 'Song', start: 0 }],
    stems,
    clickStem: clickStem?.id ?? null,
    artwork: opts.meta?.artwork ?? songArtwork(title),
    source: opts.source ?? 'user',
  }
  if (decoded.every((d) => d.bytes !== null)) song.bytes = decoded.reduce((t, d) => t + d.bytes!, 0)
  return { song, skipped, skippedFiles, notes, warnings }
}
