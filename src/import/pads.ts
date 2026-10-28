/**
 * Imported pads: WAV files, usually one per key ("Fundamental Ambient Pad - Db.wav"). The key in
 * each file's name says which key it plays; a key without its own file is played by the nearest
 * one, pitched. Used by both the main process (importing) and the renderer.
 */

export const PAD_FILE = /\.(wav|wave|bwf|aif|aiff)$/i

const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARPS: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' }

const stem = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')

// A key on its own: "Pad C", "Pad - Db", "Pad_F#", "C# Pad", "(Eb)", "Bb major".
const KEY_TOKEN = /(?:^|[\s_\-–(\[.])([A-G])(#|b|♯|♭|\s?sharp|\s?flat)?(?:\s?(?:maj(?:or)?|min(?:or)?|m))?(?=$|[\s_\-–)\].])/gi

/** The key a pad file plays, from its name; null when the name has none. */
export function keyFromFileName(name: string): string | null {
  const matches = [...stem(name).matchAll(KEY_TOKEN)]
  const m = matches[matches.length - 1]
  if (!m) return null
  const letter = m[1].toUpperCase()
  const acc = (m[2] ?? '').trim().toLowerCase()
  const raw = letter + (acc === '#' || acc === '♯' || acc === 'sharp' ? '#' : acc === 'b' || acc === '♭' || acc === 'flat' ? 'b' : '')
  return SHARPS[raw] ?? (KEYS.includes(raw) ? raw : null)
}

/** A name for a pad from its files: what they share once the key is taken out. */
export function padNameFromFiles(names: string[]): string {
  const cleaned = names.map((n) => {
    const s = stem(n)
    const matches = [...s.matchAll(KEY_TOKEN)]
    const m = matches[matches.length - 1]
    const without = m ? s.slice(0, m.index) + s.slice(m.index! + m[0].length) : s
    return without.replace(/[\s_\-–]+/g, ' ').replace(/\(\s*\)|\[\s*\]/g, '').trim()
  })
  let common = cleaned[0] ?? ''
  for (const c of cleaned.slice(1)) {
    let i = 0
    while (i < common.length && i < c.length && common[i].toLowerCase() === c[i].toLowerCase()) i++
    common = common.slice(0, i)
  }
  common = common.replace(/[\s_\-–(]+$/, '').trim()
  return common.length >= 3 ? common : cleaned[0] || 'Imported Pad'
}

/** Semitones from one key up or down to another, the short way round (-5..6). */
export function semitones(from: string, to: string): number {
  const d = (((KEYS.indexOf(to) - KEYS.indexOf(from)) % 12) + 12) % 12
  return d > 6 ? d - 12 : d
}

/**
 * Which file plays a key, and how far to pitch it: its own file if there is one, else the nearest
 * (a file without a key in its name counts as C).
 */
export function pickPadFile<T extends { key: string | null }>(files: T[], key: string): { file: T; shift: number } | null {
  let best: { file: T; shift: number } | null = null
  for (const file of files) {
    const shift = semitones(file.key ?? 'C', key)
    if (!best || Math.abs(shift) < Math.abs(best.shift)) best = { file, shift }
  }
  return best
}
