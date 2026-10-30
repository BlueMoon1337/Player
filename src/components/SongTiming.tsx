/**
 * Song Settings ▸ Time Changes and Tempo Changes, laid out like MultiTracks.com's: each change's
 * time signature (or tempo) and the time it starts, with Add Signature / Add Tempo. They can
 * also be read again from the song's click stem.
 */
import { useState } from 'react'
import { clickSamples, detectClickMap, songTiming } from '../audio/clickmap'
import type { Engine } from '../audio/engine'
import { type MeterChange, type TempoChange, bpmAt, meterMap, nearestBar, tempoMap, timeSigAt } from '../audio/grid'
import type { Song } from '../audio/types'
import { StartField, formatStart } from './SongSections'

/** The time signatures to choose from, as MultiTracks lists them. */
export const TIME_SIGNATURES = [
  ...[2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13].map((n) => `${n}/4`),
  ...[3, 6, 7, 9, 10, 11, 12, 13].map((n) => `${n}/8`),
]

interface Props {
  engine: Engine
  song: Song
  loaded: boolean
  edit: (label: string, change: () => void, field?: string) => void
}

/** Where a new change goes: the playhead (loaded song) if it's past the last change, else halfway to the end; on a bar. */
function newStart(song: Song, engine: Engine, loaded: boolean, last: number): number | null {
  const pos = loaded ? engine.position : -1
  const t = pos > last + 0.5 ? pos : (last + song.duration) / 2
  const bar = nearestBar(song, t)
  const at = bar > last + 0.05 ? bar : t
  return at < song.duration - 0.5 ? Math.round(at * 1000) / 1000 : null
}

/** Reads the tempo map again from the click stem (a Click Track, or KeyFinder's click). */
function DetectButton({ song, edit }: Pick<Props, 'song' | 'edit'>) {
  const [note, setNote] = useState<string | null>(null)
  const stem = song.stems.find((s) => s.id === song.clickStem)
  if (!song.clickStem) return null
  const detect = () => {
    if (!stem) return
    const map = detectClickMap(clickSamples(stem.buffer), stem.buffer.sampleRate, song.timeSig[1])
    if (!map) {
      setNote(`Couldn’t hear a steady click in ${stem.name}.`)
      return
    }
    // Counted in the song's beats when the click is at (or twice, or half) its tempo; else as it plays.
    let t = songTiming(map, song.bpm)
    if (t.bpm === undefined) t = songTiming(map, null)
    edit(`Detect Tempo from ${stem.name}`, () => {
      song.clickOffset = t.clickOffset
      if (t.bpm !== undefined) song.bpm = t.bpm
      if (t.timeSig) song.timeSig = t.timeSig
      song.tempos = t.tempos
      song.meters = t.meters
    })
    const n = (t.tempos?.length ?? 1) - 1
    const m = (t.meters?.length ?? 1) - 1
    setNote(
      `From ${stem.name}: ${n} tempo change${n === 1 ? '' : 's'}, ${m} time signature change${m === 1 ? '' : 's'}, bar 1 at ${formatStart(t.clickOffset)}.`,
    )
  }
  return (
    <div className="timing-detect">
      <button
        className="small"
        disabled={!stem}
        title={stem ? `Hear the tempo, bars and bar 1 in ${stem.name}` : 'Load the song to read its click'}
        onClick={detect}
      >
        Detect from {stem?.name ?? 'Click Track'}
      </button>
      {note && <span className="muted">{note}</span>}
    </div>
  )
}

/** Song Settings ▸ Tempo Changes. */
export function SongTempos({ engine, song, loaded, edit }: Props) {
  const tempos = tempoMap(song)
  /** Changes the list (from the song's tempo when it has none) and keeps `bpm` as its first. */
  const change = (label: string, f: (list: TempoChange[]) => void, field?: string) =>
    edit(
      label,
      () => {
        const list = tempoMap(song).map((t) => ({ ...t }))
        f(list)
        list.sort((a, b) => a.start - b.start)
        song.bpm = list[0].bpm
        song.tempos = list.length > 1 ? list : undefined
      },
      field,
    )
  const clash = (t: number, i: number) => tempos.some((x, k) => k !== i && Math.abs(x.start - t) < 0.05)
  return (
    <div className="song-timing">
      <div className="timing-row timing-offset">
        <span className="timing-label">Bar 1 starts at</span>
        <StartField
          value={song.clickOffset}
          onCommit={(t) => {
            if (t >= song.duration) return false
            edit('Change Click Offset', () => (song.clickOffset = t))
            return true
          }}
        />
      </div>
      <div className="sec-list" role="list">
        {tempos.map((t, i) => (
          <div key={i} className="timing-row" role="listitem">
            <input
              className="timing-bpm"
              type="number"
              aria-label="Tempo (BPM)"
              min={10}
              max={999}
              step={0.01}
              value={Math.round(t.bpm * 10000) / 10000}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v >= 10 && v <= 999) change('Change Tempo', (list) => (list[i].bpm = v), `tempo:${i}`)
              }}
            />
            <span className="timing-unit">BPM</span>
            <StartField
              value={t.start}
              disabled={i === 0}
              onCommit={(s) => {
                if (s <= 0 || s >= song.duration || clash(s, i)) return false
                change('Move Tempo Change', (list) => (list[i].start = s))
                return true
              }}
            />
            <span className="dialog-actions-spacer" />
            {i > 0 && (
              <button className="sec-del" aria-label={`Delete the tempo change at ${formatStart(t.start)}`} onClick={() => change('Delete Tempo Change', (list) => list.splice(i, 1))}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="sec-actions">
        <button
          className="small"
          onClick={() => {
            const at = newStart(song, engine, loaded, tempos[tempos.length - 1].start)
            if (at === null || clash(at, -1)) return
            change('Add Tempo Change', (list) => list.push({ start: at, bpm: bpmAt(song, at) }))
          }}
        >
          + Add Tempo
        </button>
        <DetectButton song={song} edit={edit} />
      </div>
      <p className="muted timing-hint">
        Each tempo plays from its start until the next one, in beats of the time signature. The click, the bar lines and jumps
        at the next bar follow it.
      </p>
    </div>
  )
}

/** Song Settings ▸ Time Changes. */
export function SongTimeSignatures({ engine, song, loaded, edit }: Props) {
  const meters = meterMap(song)
  const change = (label: string, f: (list: MeterChange[]) => void) =>
    edit(label, () => {
      const list = meterMap(song).map((m) => ({ start: m.start, timeSig: [m.timeSig[0], m.timeSig[1]] as [number, number] }))
      f(list)
      list.sort((a, b) => a.start - b.start)
      song.timeSig = list[0].timeSig
      song.meters = list.length > 1 ? list : undefined
    })
  const clash = (t: number, i: number) => meters.some((x, k) => k !== i && Math.abs(x.start - t) < 0.05)
  return (
    <div className="song-timing">
      <div className="sec-list" role="list">
        {meters.map((m, i) => {
          const value = m.timeSig.join('/')
          return (
            <div key={i} className="timing-row" role="listitem">
              <select
                className="timing-sig"
                aria-label="Time signature"
                value={value}
                onChange={(e) => change('Change Time Signature', (list) => (list[i].timeSig = e.target.value.split('/').map(Number) as [number, number]))}
              >
                {[...(TIME_SIGNATURES.includes(value) ? [] : [value]), ...TIME_SIGNATURES].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <StartField
                value={m.start}
                disabled={i === 0}
                onCommit={(s) => {
                  if (s <= 0 || s >= song.duration || clash(s, i)) return false
                  change('Move Time Signature Change', (list) => (list[i].start = s))
                  return true
                }}
              />
              <span className="dialog-actions-spacer" />
              {i > 0 && (
                <button
                  className="sec-del"
                  aria-label={`Delete the time signature change at ${formatStart(m.start)}`}
                  onClick={() => change('Delete Time Signature Change', (list) => list.splice(i, 1))}
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="sec-actions">
        <button
          className="small"
          onClick={() => {
            const at = newStart(song, engine, loaded, meters[meters.length - 1].start)
            if (at === null || clash(at, -1)) return
            change('Add Time Signature Change', (list) => list.push({ start: at, timeSig: timeSigAt(song, at) }))
          }}
        >
          + Add Signature
        </button>
        <DetectButton song={song} edit={edit} />
      </div>
      <p className="muted timing-hint">A new time signature starts a new bar on the beat nearest its start.</p>
    </div>
  )
}
