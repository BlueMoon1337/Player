import { songArtwork } from './synth'
import { type Song, type Stem, uid } from './types'

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|flac|aif|aiff|webm|opus)$/i

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

/** Decodes a batch of stem files into a new song with one channel per file. */
export async function importStems(ctx: AudioContext, files: File[]): Promise<Song> {
  const audio = files.filter(isAudioFile).sort((a, b) => a.name.localeCompare(b.name))
  if (audio.length === 0) throw new Error('No audio files found')
  const names = audio.map((f) => f.name.replace(/\.[^.]+$/, ''))
  const prefix = commonPrefix(names)
  const stems: Stem[] = await Promise.all(
    audio.map(async (f) => {
      const data = await f.arrayBuffer()
      const buffer = await ctx.decodeAudioData(data)
      return { id: uid('stem'), name: stemName(f.name, prefix).slice(0, 12), buffer }
    }),
  )
  const duration = Math.max(...stems.map((s) => s.buffer.duration))
  const title = prefix.replace(/[\s_\-.]+$/, '') || (audio.length === 1 ? names[0] : 'Imported Song')
  return {
    id: uid('song'),
    title,
    key: 'C',
    bpm: 120,
    timeSig: [4, 4],
    clickOffset: 0,
    duration,
    sections: [{ id: uid('sec'), name: 'Song', start: 0 }],
    stems,
    artwork: songArtwork(title),
    source: 'user',
  }
}
