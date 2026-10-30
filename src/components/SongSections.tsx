/**
 * Song Settings ▸ Sections, laid out like MultiTracks.com's section editor: each section's name
 * from a list and the time it starts (minutes:seconds:milliseconds), with ✕ to delete it.
 */
import { useState } from 'react'
import type { Engine } from '../audio/engine'
import { barLength } from '../audio/synth'
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
function StartField({ value, disabled, onCommit }: { value: number; disabled?: boolean; onCommit: (t: number) => boolean }) {
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

  /** A new section halfway through the last one (on a bar), or at the playhead. */
  const add = (at?: number) => {
    let t = at
    if (t === undefined) {
      const i = song.sections.length - 1
      const start = song.sections[i].start
      const mid = (start + sectionEnd(song, i)) / 2
      const bar = barLength(song)
      t = Math.max(start + 0.1, song.clickOffset + Math.round((mid - song.clickOffset) / bar) * bar)
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
              <StartField
                value={s.start}
                disabled={i === 0}
                onCommit={(t) => {
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
              {i > 0 && (
                <button
                  className="sec-del"
                  title={`Delete ${s.name}`}
                  aria-label={`Delete ${s.name}`}
                  onClick={() =>
                    edit(`Delete Section “${s.name}”`, () => {
                      song.sections.splice(i, 1)
                      song.sections[0].start = 0
                    })
                  }
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="sec-actions">
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
