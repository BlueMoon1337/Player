/**
 * Song Settings ▸ Sections, laid out like MultiTracks.com's section editor: each section's name
 * from a list and the time it starts (minutes:seconds:milliseconds), with ✕ to delete it.
 */
import { useState } from 'react'
import type { Engine } from '../audio/engine'
import { FADE_DEFAULT, FADE_MAX, FADE_MIN, fadeOut, hasCuts, heardLength, playedLength, toHeard, toSong } from '../audio/arrangement'
import { nearestBar } from '../audio/grid'
import { type Song, sectionColor, sectionEnd, uid } from '../audio/types'
import { promptDialog } from './Ask'
import { type SectionScope, ScopeBar } from './Timeline'

const numbered = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name} ${i + 1}`)

/** The names to choose from; a song's own names (from its file or typed in) are added to them. */
export const SECTION_CHOICES = [
  'Count In',
  'Intro',
  'Verse',
  ...numbered('Verse', 6),
  'Pre-chorus',
  ...numbered('Pre-chorus', 3),
  'Chorus',
  ...numbered('Chorus', 4),
  'Post-chorus',
  'Bridge',
  ...numbered('Bridge', 3),
  'Interlude',
  'Instrumental',
  'Turnaround',
  'Breakdown',
  'Solo',
  'Vamp',
  'Refrain',
  'Tag',
  'Outro',
  'Ending',
]

const CUSTOM = '\u0000custom'

/** "04:18:462", as MultiTracks writes a section's start. */
export function formatStart(t: number): string {
  const ms = Math.round(Math.max(0, t) * 1000)
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms % 1000).padStart(3, '0')}`
}

/** "4:18:462", "4:18.5", "258.462" (seconds) → seconds; null if it isn't a time. */
export function parseStart(text: string): number | null {
  const t = text.trim()
  const m = /^(\d{1,3}):(\d{1,2})(?:[:.](\d{1,3}))?$/.exec(t)
  if (m) {
    if (Number(m[2]) > 59) return null
    return Number(m[1]) * 60 + Number(m[2]) + Number((m[3] ?? '0').padEnd(3, '0')) / 1000
  }
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null
}

/** A start time you type into: applied when you leave the box or press Return. */
export function StartField({ value, disabled, onCommit }: { value: number; disabled?: boolean; onCommit: (t: number) => boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const commit = () => {
    if (draft === null) return
    const t = parseStart(draft)
    const ok = t !== null && onCommit(t)
    setBad(!ok)
    if (ok) setDraft(null)
  }
  return (
    <input
      className={`sec-start ${bad ? 'bad' : ''}`}
      aria-label="Start time"
      value={draft ?? formatStart(value)}
      disabled={disabled}
      title={disabled ? 'The first section starts the song' : 'Minutes:seconds:milliseconds'}
      onChange={(e) => {
        setDraft(e.target.value)
        setBad(false)
      }}
      onBlur={() => {
        commit()
        setDraft(null)
        setBad(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(null)
          setBad(false)
        }
      }}
    />
  )
}

/** A fade's length in seconds, typed in: applied when you leave the box or press Return. */
function FadeField({ value, onCommit }: { value: number; onCommit: (seconds: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft.replace(',', '.'))
    if (Number.isFinite(n) && n > 0) onCommit(Math.max(FADE_MIN, Math.min(FADE_MAX, Math.round(n * 10) / 10)))
    setDraft(null)
  }
  return (
    <input
      className="sec-fade-len"
      aria-label="Fade out length in seconds"
      inputMode="decimal"
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(null)
        }
      }}
    />
  )
}

export function SongSections({
  engine,
  song,
  loaded,
  edit,
  scope,
}: {
  engine: Engine
  song: Song
  loaded: boolean
  edit: (label: string, change: () => void, field?: string) => void
  scope?: SectionScope
}) {
  const sort = () => song.sections.sort((a, b) => a.start - b.start)
  const clash = (t: number, except?: string) => song.sections.some((s) => s.id !== except && Math.abs(s.start - t) < 0.05)
  const latest = song.duration - 0.1
  const fade = fadeOut(song)

  /** A new section halfway through the last one (on a bar), or at the playhead. */
  const add = (at?: number) => {
    let t = at
    if (t === undefined) {
      const i = song.sections.length - 1
      const start = song.sections[i].start
      const mid = (start + sectionEnd(song, i)) / 2
      t = Math.max(start + 0.1, nearestBar(song, mid))
    }
    t = Math.min(latest, Math.max(0, t))
    if (clash(t)) return
    const used = new Set(song.sections.map((s) => s.name))
    const name = numbered('Verse', 9).find((n) => !used.has(n)) ?? 'Verse'
    edit(`Add Section “${name}”`, () => {
      song.sections.push({ id: uid('sec'), name, start: t! })
      sort()
    })
  }

  return (
    <div className="song-sections">
      {scope && <ScopeBar scope={scope} />}
      <div className="sec-list" role="list">
        {song.sections.map((s, i) => {
          const choices = SECTION_CHOICES.includes(s.name) ? SECTION_CHOICES : [s.name, ...SECTION_CHOICES]
          if (s.skip) {
            // Cut: its music is left out of this arrangement.
            return (
              <div key={s.id} className="sec-row cut" role="listitem" style={{ ['--c' as string]: sectionColor(s.name) }}>
                <span className="sec-cut-name">{s.name}</span>
                <span className="sec-cut-note">Cut · {formatStart(sectionEnd(song, i) - s.start).slice(0, 5)} of music left out</span>
                <span className="dialog-actions-spacer" />
                <button className="small" onClick={() => edit(`Put Back “${s.name}”`, () => delete s.skip)}>
                  Put Back
                </button>
              </div>
            )
          }
          return (
            <div key={s.id} className="sec-row" role="listitem" style={{ ['--c' as string]: sectionColor(s.name) }}>
              <select
                className="sec-name"
                aria-label="Section"
                value={s.name}
                onChange={async (e) => {
                  let name: string | null = e.target.value
                  if (name === CUSTOM) {
                    name = await promptDialog({ title: 'Section Name', defaultValue: s.name, confirmLabel: 'OK', placeholder: 'Verse 1, Chorus, Vamp…' })
                  }
                  if (name && name !== s.name) edit('Rename Section', () => (s.name = name!))
                }}
              >
                {choices.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                <option value={CUSTOM}>Other name…</option>
              </select>
              {/* As heard: cut sections before it aren't counted. */}
              <StartField
                value={toHeard(song, s.start)}
                disabled={i === 0}
                onCommit={(heard) => {
                  const t = toSong(song, heard)
                  if (t <= 0 || t > latest || clash(t, s.id)) return false
                  edit('Move Section', () => {
                    s.start = t
                    sort()
                  })
                  return true
                }}
              />
              {loaded && (
                <button className="sec-jump" title={`Play from ${s.name}`} onClick={() => engine.seek(s.start)}>
                  ▶
                </button>
              )}
              <span className="dialog-actions-spacer" />
              {fade?.section === s ? (
                <span className="sec-fade" title="The song fades out over the end of this section and stops there">
                  Fades out over
                  <FadeField value={s.fadeOut!} onCommit={(n) => n !== s.fadeOut && edit('Change Fade Out', () => (s.fadeOut = n))} />s
                  <button className="sec-fade-off" title="Remove the fade out" aria-label="Remove fade out" onClick={() => edit('Remove Fade Out', () => delete s.fadeOut)}>
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  className="small sec-fade-btn"
                  title={`Fade out at the end of ${s.name}: the song stops there${fade ? ` (instead of at ${fade.section.name})` : ''}`}
                  onClick={() =>
                    edit(`Fade Out at “${s.name}”`, () => {
                      for (const x of song.sections) delete x.fadeOut
                      s.fadeOut = Math.min(FADE_DEFAULT, Math.max(1, sectionEnd(song, i) - s.start))
                    })
                  }
                >
                  Fade Out
                </button>
              )}
              {song.sections.filter((x) => !x.skip).length > 1 && (
                <button
                  className="sec-del"
                  title={`Cut ${s.name}: leave its music out (Put Back undoes it)`}
                  aria-label={`Cut ${s.name}`}
                  onClick={() => edit(`Cut “${s.name}”`, () => (s.skip = true))}
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="sec-actions">
        {(hasCuts(song) || fade) && (
          <span className="muted sec-length">
            Plays for {formatStart(playedLength(song)).slice(0, 5)} (
            {[
              hasCuts(song) && `${formatStart(song.duration - heardLength(song)).slice(0, 5)} cut`,
              fade && `fades out at the end of ${fade.section.name}`,
            ]
              .filter(Boolean)
              .join(', ')}
            )
          </span>
        )}
        <button className="small" onClick={() => add()}>
          + Add Section
        </button>
        {loaded && (
          <button className="small" onClick={() => add(engine.position)}>
            + Add at Playhead
          </button>
        )}
      </div>
    </div>
  )
}
