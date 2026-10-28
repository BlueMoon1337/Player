/**
 * Spoken section cues ("Chorus", "two, three, four"), made with the computer's own voices: `say`
 * on a Mac, the Windows speech voices, or espeak on Linux. Each phrase is rendered once per
 * language to a WAV in <userData>/cues/<language>/ and served as app://player/cues/<language>/<file>.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const CUE_LANGUAGES = ['en-female', 'en-male', 'es', 'pt', 'fr'] as const
export type CueLanguage = (typeof CUE_LANGUAGES)[number]

/** Mac voices to try, best first; any voice of the language will do after these. */
const MAC_VOICES: Record<CueLanguage, { names: string[]; locale: string }> = {
  'en-female': { names: ['Samantha', 'Karen', 'Moira', 'Tessa', 'Allison', 'Ava', 'Susan', 'Victoria', 'Zoe'], locale: 'en' },
  'en-male': { names: ['Daniel', 'Alex', 'Tom', 'Aaron', 'Oliver', 'Fred', 'Rishi'], locale: 'en' },
  es: { names: ['Mónica', 'Monica', 'Paulina', 'Jorge', 'Juan', 'Diego'], locale: 'es' },
  pt: { names: ['Luciana', 'Joana', 'Felipe', 'Catarina'], locale: 'pt' },
  fr: { names: ['Thomas', 'Amélie', 'Amelie', 'Audrey', 'Aurélie'], locale: 'fr' },
}

const WIN_CULTURE: Record<CueLanguage, { culture: string; gender: string }> = {
  'en-female': { culture: 'en', gender: 'Female' },
  'en-male': { culture: 'en', gender: 'Male' },
  es: { culture: 'es', gender: '' },
  pt: { culture: 'pt', gender: '' },
  fr: { culture: 'fr', gender: '' },
}

const ESPEAK_VOICE: Record<CueLanguage, string> = { 'en-female': 'en+f3', 'en-male': 'en', es: 'es', pt: 'pt', fr: 'fr' }

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 20000, env: { ...process.env, ...env }, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ),
  )

let macVoiceList: { name: string; locale: string }[] | null = null

async function macVoice(lang: CueLanguage): Promise<string> {
  if (!macVoiceList) {
    const out = await run('say', ['-v', '?'])
    macVoiceList = out
      .split('\n')
      .map((l) => /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z]{2,})/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ name: m[1].trim(), locale: m[2] }))
  }
  const want = MAC_VOICES[lang]
  const named = want.names.find((n) => macVoiceList!.some((v) => v.name === n))
  if (named) return named
  const any = macVoiceList.find((v) => v.locale.startsWith(want.locale))
  if (!any) throw new Error(`there's no ${want.locale} voice on this Mac (add one in System Settings ▸ Accessibility ▸ Spoken Content)`)
  return any.name
}

const WIN_SCRIPT = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like ($env:CUE_CULTURE + '*') -and ($env:CUE_GENDER -eq '' -or $_.VoiceInfo.Gender.ToString() -eq $env:CUE_GENDER) } | Select-Object -First 1
if (-not $v) { $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like ($env:CUE_CULTURE + '*') } | Select-Object -First 1 }
if (-not $v) { exit 3 }
$s.SelectVoice($v.VoiceInfo.Name)
$s.SetOutputToWaveFile($env:CUE_OUT)
$s.Speak($env:CUE_TEXT)
$s.Dispose()
`

async function speak(lang: CueLanguage, text: string, out: string) {
  if (process.platform === 'darwin') {
    await run('say', ['-v', await macVoice(lang), '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', text])
  } else if (process.platform === 'win32') {
    const { culture, gender } = WIN_CULTURE[lang]
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], {
        CUE_TEXT: text,
        CUE_OUT: out,
        CUE_CULTURE: culture,
        CUE_GENDER: gender,
      })
    } catch (e) {
      if ((e as { code?: number }).code === 3) throw new Error(`there's no ${culture} speech voice installed (Windows Settings ▸ Time & language ▸ Speech)`)
      throw e
    }
  } else {
    try {
      await run('espeak-ng', ['-v', ESPEAK_VOICE[lang], '-w', out, text])
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      try {
        await run('espeak', ['-v', ESPEAK_VOICE[lang], '-w', out, text])
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('spoken cues need espeak-ng (install it with your package manager)')
        throw e2
      }
    }
  }
}

/** A short, plain phrase: what a cue may say. */
export function cleanPhrase(p: unknown): string | null {
  if (typeof p !== 'string') return null
  const s = p.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60)
  return s || null
}

/**
 * Makes (or finds) a WAV for each phrase in the language's voice. Resolves to the file name of
 * each, in <root>/<language>/.
 */
export async function renderCues(root: string, lang: CueLanguage, phrases: string[]): Promise<Record<string, string>> {
  const dir = path.join(root, lang)
  await fs.mkdir(dir, { recursive: true })
  const files: Record<string, string> = {}
  for (const phrase of phrases) {
    const file = `${createHash('sha1').update(`${lang}\n${phrase}`).digest('hex').slice(0, 20)}.wav`
    const out = path.join(dir, file)
    const exists = await fs
      .stat(out)
      .then((s) => s.size > 44)
      .catch(() => false)
    if (!exists) {
      const tmp = `${out}.${process.pid}.tmp.wav`
      try {
        await speak(lang, phrase, tmp)
        await fs.rename(tmp, out)
      } catch (e) {
        await fs.rm(tmp, { force: true })
        throw e
      }
    }
    files[phrase] = file
  }
  return files
}
