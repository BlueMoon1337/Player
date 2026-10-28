/**
 * MultiTracks.com downloads: a zip (or the folder it unzips to) named
 * "Title-Album-Key-BPMbpm", holding a MultiTracks/ folder of WAV stems (Click Track and
 * Guide among them), Album.jpg, and an Ableton set (MultiTrack.als) whose locators mark the
 * sections. These rules pick what Player needs out of one; they work for any folder of stems.
 */

const AUDIO = /\.(wav|wave|bwf|rf64|aif|aiff|flac|mp3|m4a|aac|ogg|oga|opus)$/i

export interface SongName {
  title: string
  album?: string
  key?: string
  bpm?: number
}

/** "Goodness of God-Victory-Ab-63.00bpm" → Goodness of God, Victory, Ab, 63. */
export function parseSongName(raw: string): SongName {
  const name = raw.replace(/\.zip$/i, '').trim()
  const m = /^(.+?)-(.+)-([A-G](?:#|b)?m?)-(\d+(?:\.\d+)?)\s*bpm$/i.exec(name)
  if (!m) return { title: name }
  const bpm = Number(m[4])
  return {
    title: m[1].trim(),
    album: m[2].trim(),
    key: m[3][0].toUpperCase() + m[3].slice(1),
    bpm: bpm >= 20 && bpm <= 400 ? Math.round(bpm * 100) / 100 : undefined,
  }
}

/** Files a Mac or Ableton leaves around that aren't part of the song. */
export function isJunk(path: string): boolean {
  const parts = path.split('/')
  const base = parts[parts.length - 1]
  return parts.some((p) => p === '__MACOSX' || p === '.DS_Store') || base.startsWith('._') || base.startsWith('.')
}

export interface PickedFiles {
  stems: string[]
  artwork?: string
  ableton?: string
}

const depth = (p: string) => p.split('/').length

/** Chooses the stems, cover picture and Ableton set from a list of paths in a zip or folder. */
export function pickFiles(paths: string[]): PickedFiles {
  const files = paths.filter((p) => !isJunk(p))
  const audio = files.filter((p) => AUDIO.test(p))
  // A MultiTracks/ folder holds the stems; anything else (e.g. a preview MP3) is left out.
  const inFolder = audio.filter((p) => /(^|\/)multitracks\//i.test(p))
  const stems = (inFolder.length ? inFolder : audio).sort((a, b) => a.localeCompare(b))
  const byDepth = (a: string, b: string) => depth(a) - depth(b)
  const artwork =
    files.filter((p) => /(^|\/)(album|artwork|cover|folder)\.(jpe?g|png)$/i.test(p)).sort(byDepth)[0] ??
    files.filter((p) => /\.(jpe?g|png)$/i.test(p) && depth(p) <= 2).sort(byDepth)[0]
  // Live keeps older copies in Backup/; the set itself is the shallowest one.
  const ableton = files.filter((p) => /\.als$/i.test(p) && !/(^|\/)backup\//i.test(p)).sort(byDepth)[0]
  return { stems, artwork, ableton }
}

/** Whether a stem is the song's click (MultiTracks calls it "Click Track"). */
export function isClickStem(name: string): boolean {
  return /^(click(\s*track)?|metronome)$/i.test(name.replace(/\.[^.]+$/, '').trim())
}
