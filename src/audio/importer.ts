import { songArtwork } from './synth'
import { type Section, type Song, type Stem, uid } from './types'
import { type WavMeta, readWav } from './wav'

const AUDIO_EXT = /\.(wav|wave|bwf|rf64|mp3|m4a|aac|ogg|oga|flac|aif|aiff|webm|opus)$/i

export function isAudioFile(f: File) {
  return f.type.startsWith('audio/') || AUDIO_EXT.test(f.name)
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

export interface SkippedFile {
  name: string
  reason: string
}

export interface ImportResult {
  song: Song
  skipped: SkippedFile[]
  /** Notes about what was picked up from file metadata, for the UI to show. */
  notes: string[]
}

interface Decoded {
  file: File
  buffer: AudioBuffer
  meta: WavMeta | null
}

async function decodeFile(ctx: AudioContext, file: File): Promise<Decoded> {
  const data = await file.arrayBuffer()
  // WAV files go through our own reader so every PCM/float variant decodes the same in
  // every browser and embedded markers/tempo survive. Anything else goes to the browser.
  const wav = readWav(data)
  if (wav?.decode) return { file, buffer: wav.decode(ctx), meta: wav.meta }
  try {
    const buffer = await ctx.decodeAudioData(data)
    return { file, buffer, meta: wav?.meta ?? null }
  } catch {
    throw new Error(wav ? `unsupported WAV encoding (${wav.encoding})` : 'not a format this browser can decode')
  }
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

/** Decodes a batch of stem files into a new song with one channel per file. */
export async function importStems(
  ctx: AudioContext,
  files: File[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<ImportResult> {
  const audio = files.filter(isAudioFile).sort((a, b) => a.name.localeCompare(b.name))
  const skipped: SkippedFile[] = files.filter((f) => !isAudioFile(f)).map((f) => ({ name: f.name, reason: 'not an audio file' }))
  if (audio.length === 0) throw new Error('No audio files found')

  const decoded: Decoded[] = []
  // One file at a time keeps peak memory down with long multi-channel stems.
  for (const [i, f] of audio.entries()) {
    onProgress?.(i, audio.length, f.name)
    // Yield so the progress text paints before the (synchronous) decode.
    await new Promise((r) => setTimeout(r, 0))
    try {
      decoded.push(await decodeFile(ctx, f))
    } catch (e) {
      skipped.push({ name: f.name, reason: (e as Error).message })
    }
  }
  if (decoded.length === 0) {
    throw new Error(skipped.map((s) => `${s.name}: ${s.reason}`).join('; '))
  }

  const names = decoded.map((d) => d.file.name.replace(/\.[^.]+$/, ''))
  const prefix = commonPrefix(names)
  const stems: Stem[] = decoded.map((d) => ({
    id: uid('stem'),
    name: stemName(d.file.name, prefix).slice(0, 12),
    buffer: d.buffer,
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
    id: uid('song'),
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
    source: 'user',
  }
  return { song, skipped, notes }
}
