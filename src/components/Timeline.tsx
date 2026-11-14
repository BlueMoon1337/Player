import { useEffect, useRef, useState } from 'react'
import type { Engine, EngineState, JumpMode, LoopMode } from '../audio/engine'
import { heardSections, joins, pastCut, playedLength, toHeard, toSong } from '../audio/arrangement'
import { beatGrid, nearestBar } from '../audio/grid'
import {
  SECTION_TYPES,
  type Section,
  type Song,
  formatTime,
  nextSectionName,
  sectionAbbrev,
  sectionColor,
  sectionEnd,
  uid,
} from '../audio/types'
import { UNDO_KEY, showNote } from '../library/history'
import { getSettings, useSettings } from '../settings'
import { type MenuEntry, type MenuItem, promptDialog, showContextMenu } from './Ask'
import { LoopForeverIcon, LoopOnceIcon } from './LoopIcons'

interface Props {
  engine: Engine
  state: EngineState
  song: Song | null
  peaks: Float32Array | null
  jumpMode: JumpMode
  /** Bumped when the song's sections change so the canvas redraws. */
  version: number
  /** Edit mode ("Setlist / Song Map"): sections become blocks with add / delete controls. */
  editing?: boolean
  /** Makes one undoable change to the song. */
  edit?: (label: string, change: () => void) => void
  /** Edit mode: whether section changes go to this setlist only or to every setlist. */
  scope?: SectionScope
}

export interface SectionScope {
  setlistName: string
  /** The song is in the current setlist; if not, section changes are always the song's own. */
  inSetlist: boolean
  value: 'setlist' | 'all'
  set: (v: 'setlist' | 'all') => void
  /** This setlist has its own edit of the song's sections. */
  edited: boolean
  /** Makes this setlist's sections the song's own, in every setlist. */
  applyEverywhere: () => void
  /** Drops this setlist's edit: back to the song's own sections. */
  revert: () => void
  /** Opens the sections as a list (Song Settings ▸ Sections). */
  openList?: () => void
}

/** Above the song map and the section list: where section changes go, and this setlist's edit of them. */
export function ScopeBar({ scope }: { scope: SectionScope }) {
  if (!scope.inSetlist) {
    return (
      <div className="smap-scope">
        <span className="smap-scope-label">Not in “{scope.setlistName}”: section changes apply to this song in every setlist</span>
      </div>
    )
  }
  return (
    <div className="smap-scope">
      <span className="smap-scope-label">Section changes apply to</span>
      <div className="smap-scope-seg" role="radiogroup" aria-label="Section changes apply to">
        {(
          [
            ['setlist', `“${scope.setlistName}” only`],
            ['all', 'Every setlist'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} role="radio" aria-checked={scope.value === v} className={scope.value === v ? 'on' : ''} onClick={() => scope.set(v)}>
            {label}
          </button>
        ))}
      </div>
      <span className="dialog-actions-spacer" />
      {scope.edited && (
        <>
          <span className="smap-scope-note">Edited for “{scope.setlistName}”</span>
          <button className="smap-scope-act" onClick={scope.applyEverywhere} title="Make these sections the song’s own, in every setlist">
            Use in Every Setlist
          </button>
          <button className="smap-scope-act" onClick={scope.revert} title="Go back to the song’s own sections in this setlist">
            Revert
          </button>
        </>
      )}
      {scope.openList && (
        <button className="smap-scope-act" onClick={scope.openList} title="The sections as a list, with their start times">
          Section List…
        </button>
      )}
    </div>
  )
}

/** A section narrower than this shows a ••• menu instead of its − and + buttons (as Playback does). */
const FULL_CONTROLS_PX = 130
/** A section narrower than this has its loop button at the bottom left, under its badge (as Playback does). */
const LOOP_ON_TOP_PX = 110

/**
 * Like Playback, the timeline shows about this much of the song across its width and scrolls for
 * the rest (a song this short or shorter fits the width).
 */
const VISIBLE_SECONDS = 60
/** While playing, the view follows with the playhead this far in from the left. */
const PLAYHEAD_LEAD = 0.12
/** After scrolling by hand, the view waits this long before following the playhead again. */
const HAND_SCROLL_MS = 3000

export function Timeline({ engine, state, song, peaks, jumpMode, version, editing = false, edit, scope }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const grid = useSettings().waveformGrid
  /** Width of the visible part; the song's full width is VISIBLE_SECONDS to this. */
  const [viewW, setViewW] = useState(1000)
  const handScrollUntil = useRef(0)
  // Everything here is drawn as the song is heard: cut sections (arrangement.ts) are left out.
  const heardLength = song ? playedLength(song) : 0
  const heard = song ? heardSections(song) : []
  const contentW = song ? Math.max(viewW, Math.round((heardLength / VISIBLE_SECONDS) * viewW)) : viewW

  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth || 1000))
    ro.observe(sc)
    return () => ro.disconnect()
  }, [song, editing])

  // A new song starts at the left.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 0
  }, [song?.id])

  /** Scrolling by hand: a vertical wheel scrolls sideways too, and the view stops following for a moment. */
  const scrollProps = {
    onWheel: (e: React.WheelEvent<HTMLDivElement>) => {
      handScrollUntil.current = performance.now() + HAND_SCROLL_MS
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
    },
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      // The scrollbar itself.
      if (e.target === e.currentTarget) handScrollUntil.current = performance.now() + HAND_SCROLL_MS
    },
  }

  // Static layer: section bands + waveform. Redrawn on resize or song change.
  useEffect(() => {
    const cv = canvas.current
    const el = wrap.current
    if (!cv || !el) return
    const draw = () => {
      const w = el.clientWidth
      // A long song makes a wide canvas; keep it within what a canvas can hold.
      const dpr = Math.min(window.devicePixelRatio || 1, 16000 / Math.max(1, w))
      const h = el.clientHeight
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      const g = cv.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      if (!song) return
      const length = playedLength(song)
      const x = (t: number) => (t / length) * w
      if (editing) {
        drawSongMap(g, song, peaks, w, h)
        return
      }
      for (const { section: s, start, end } of heardSections(song)) {
        const x0 = x(start)
        const x1 = x(end)
        g.fillStyle = sectionColor(s.name) + '2a'
        g.fillRect(x0, 0, x1 - x0, h)
        g.fillStyle = sectionColor(s.name)
        g.fillRect(x0, 0, 2, h)
      }
      if (peaks) {
        const mid = h / 2
        for (const { section: s, start, end } of heardSections(song)) {
          const x0 = Math.floor(x(start))
          const x1 = Math.ceil(x(end))
          g.fillStyle = sectionColor(s.name) + 'd0'
          for (let px = x0; px < x1; px++) {
            const v = peakAt(song, peaks, px, w)
            const amp = Math.max(0.5, v * (h * 0.42))
            g.fillRect(px, mid - amp, 1, amp * 2)
          }
        }
      }
      if (grid) drawGrid(g, song, w, h, 0.16)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [song, peaks, version, editing, grid])

  // Playhead + active section highlight run on rAF without re-rendering React. While playing the
  // view follows the playhead; when stopped, it only moves to show a playhead that jumped out of view.
  useEffect(() => {
    let raf = 0
    let lastIdx = -1
    let lastPos = -1
    let lastDraw = 0
    const loop = (now: number) => {
      // Power Saver: the playhead and scrolling update ten times a second instead of every frame.
      if (getSettings().powerSaver && now - lastDraw < 100) {
        raf = requestAnimationFrame(loop)
        return
      }
      lastDraw = now
      if (song && playhead.current) {
        const pos = toHeard(song, engine.position)
        const length = playedLength(song)
        playhead.current.style.left = `${(pos / length) * 100}%`
        const sc = scroller.current
        const width = wrap.current?.offsetWidth ?? 0
        if (sc && width > sc.clientWidth + 1 && performance.now() > handScrollUntil.current) {
          const x = (pos / length) * width
          const inView = x >= sc.scrollLeft && x <= sc.scrollLeft + sc.clientWidth - 24
          if (engine.isPlaying || (!inView && pos !== lastPos)) sc.scrollLeft = x - sc.clientWidth * PLAYHEAD_LEAD
        }
        lastPos = pos
        // The section playing, among those heard (the labels are of those).
        let idx = 0
        heardSections(song).forEach((h, i) => {
          if (h.start <= pos + 1e-6) idx = i
        })
        if (idx !== lastIdx && labels.current) {
          labels.current.querySelectorAll('.section-label').forEach((n, i) => n.classList.toggle('current', i === idx))
          lastIdx = idx
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [engine, song, version, editing])

  if (!song) return <div className="timeline empty">No song loaded</div>

  const seekFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    engine.seek(toSong(song, ((e.clientX - r.left) / r.width) * heardLength))
  }

  if (editing && edit) {
    return (
      <div className={`timeline song-map ${scope ? 'scoped' : ''}`}>
        {scope && <ScopeBar scope={scope} />}
        <button className="smap-btn smap-add-start" title="Add a section at the playhead" onClick={(e) => showAt(e, addAtPlayhead(song, engine, edit))}>
          <PlusIcon />
        </button>
        <div className="tl-scroll" ref={scroller} {...scrollProps}>
          <div
            className="wave"
            ref={wrap}
            style={{ width: contentW }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              e.currentTarget.setPointerCapture(e.pointerId)
              seekFromEvent(e)
            }}
          >
            <canvas ref={canvas} />
            <div className="smap-blocks" ref={labels}>
              {heard.map(({ section: s, index: i, start, end }) => {
                const left = (start / heardLength) * 100
                const width = ((end - start) / heardLength) * 100
                const px = (contentW * width) / 100
                const looping = state.loop?.sectionId === s.id ? state.loop.mode : null
                const menu = sectionMenu(song, i, engine, edit, looping)
                return (
                  <div
                    key={s.id}
                    className={`section-label smap-block ${looping ? 'looping' : ''} ${state.pendingJump?.sectionId === s.id ? 'pending' : ''}`}
                    style={{ left: `${left}%`, width: `${width}%`, ['--c' as string]: sectionColor(s.name) }}
                    onContextMenu={(e) => showContextMenu(e, menu)}
                  >
                    <button
                      className="smap-badge"
                      title={`${s.name}: jump here${i < 9 ? ` (${i + 1})` : ''}`}
                      onClick={() => engine.jumpToSection(s.id, jumpMode)}
                    >
                      {sectionAbbrev(s.name)}
                    </button>
                    <button
                      className={`smap-loop ${px < LOOP_ON_TOP_PX ? 'below' : ''} ${looping ? 'on' : ''}`}
                      title={loopTitle(s.name, looping)}
                      aria-pressed={!!looping}
                      onClick={() => engine.cycleLoop(s.id)}
                    >
                      {looping === 'forever' ? <LoopForeverIcon /> : <LoopOnceIcon />}
                    </button>
                    {px >= FULL_CONTROLS_PX ? (
                      <>
                        {heard.length > 1 && (
                          <button className="smap-btn smap-del" title={`Cut ${s.name}: leave its music out`} onClick={() => cutSection(song, i, edit)}>
                            <MinusIcon />
                          </button>
                        )}
                        <button className="smap-btn smap-add" title="Add a section after this one" onClick={(e) => showAt(e, insertMenu(song, i, engine, edit))}>
                          <PlusIcon />
                        </button>
                      </>
                    ) : (
                      <button className="smap-btn smap-more" title={`${s.name}: more`} onClick={(e) => showAt(e, menu)}>
                        •••
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {/* Where sections were cut: their music is left out here. Click to put it back. */}
            {joins(song).map((j) => (
              <button
                key={j.sections.map((x) => x.id).join()}
                className="smap-cut"
                style={{ left: `${(j.at / heardLength) * 100}%` }}
                title={`${j.sections.map((x) => x.name).join(', ')} cut here (${formatTime(j.length)}). Click to put it back.`}
                onClick={() => putBack(j.sections, edit)}
              >
                ✂
              </button>
            ))}
            <div className="playhead" ref={playhead} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="timeline">
      <div className="tl-scroll" ref={scroller} {...scrollProps}>
        <div className="tl-content" style={{ width: contentW }}>
          <div className="section-labels" ref={labels}>
            {heard.map(({ section: s, index: i, start, end }) => {
              const left = (start / heardLength) * 100
              const width = ((end - start) / heardLength) * 100
              const looping = state.loop?.sectionId === s.id ? state.loop.mode : null
              const pending = state.pendingJump?.sectionId === s.id
              return (
                <div
                  key={s.id}
                  className={`section-label ${looping ? 'looping' : ''} ${pending ? 'pending' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%`, ['--c' as string]: sectionColor(s.name) }}
                >
                  <button
                    className="section-jump"
                    onClick={() => engine.jumpToSection(s.id, jumpMode)}
                    title={`Jump to ${s.name}${i < 9 ? ` (${i + 1})` : ''}`}
                    data-abbrev={sectionAbbrev(s.name)}
                  >
                    {/* A narrow section shows its badge abbreviation (V1, Pc) instead of a cut-off name. */}
                    <span className="sj-full">{s.name}</span>
                  </button>
                  <button
                    className={`section-loop ${looping ? 'on' : ''}`}
                    onClick={() => engine.cycleLoop(s.id)}
                    title={loopTitle(s.name, looping)}
                    aria-pressed={!!looping}
                  >
                    {looping === 'forever' ? <LoopForeverIcon /> : <LoopOnceIcon />}
                  </button>
                </div>
              )
            })}
          </div>
          <div
            className="wave"
            ref={wrap}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              seekFromEvent(e)
            }}
          >
            <canvas ref={canvas} />
            {state.loop && (
              <div
                className="loop-region"
                style={{
                  left: `${(toHeard(song, state.loop.start) / heardLength) * 100}%`,
                  width: `${((state.loop.end - state.loop.start) / heardLength) * 100}%`,
                }}
              />
            )}
            <div className="playhead" ref={playhead} />
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------- song map

/** Edit mode's look: a pale waveform over bar lines; the section blocks are drawn as elements on top. */
/** Waveform Grid: a line on every bar, fainter ones on the beats (when they're far enough apart). */
function drawGrid(g: CanvasRenderingContext2D, song: Song, w: number, h: number, barAlpha: number) {
  const length = playedLength(song)
  for (const b of beatGrid(song)) {
    // Beats in a cut section aren't heard.
    if (b.time < 0 || pastCut(song, b.time) !== null) continue
    const isBar = b.index === 0
    if (!isBar && (b.length / length) * w < 6) continue
    g.fillStyle = `rgba(255, 255, 255, ${isBar ? barAlpha : barAlpha / 2.5})`
    g.fillRect(Math.round((toHeard(song, b.time) / length) * w), 0, 1, h)
  }
}

/** The waveform's height at a pixel of the timeline as heard (`w` wide), from the song's own peaks. */
function peakAt(song: Song, peaks: Float32Array, px: number, w: number): number {
  const length = playedLength(song)
  const from = toSong(song, (px / w) * length)
  const to = from + length / w
  const b = Math.floor((from / song.duration) * peaks.length)
  const b2 = Math.max(b + 1, Math.floor((to / song.duration) * peaks.length))
  let v = 0
  for (let k = b; k < b2 && k < peaks.length; k++) v = Math.max(v, peaks[k])
  return v
}

function drawSongMap(g: CanvasRenderingContext2D, song: Song, peaks: Float32Array | null, w: number, h: number) {
  if (getSettings().waveformGrid) drawGrid(g, song, w, h, 0.09)
  if (!peaks) return
  const mid = h / 2
  g.fillStyle = 'rgba(228, 228, 231, 0.72)'
  for (let px = 0; px < w; px++) {
    const v = peakAt(song, peaks, px, w)
    const amp = Math.max(0.5, v * (h * 0.36))
    g.fillRect(px, mid - amp, 1, amp * 2)
  }
}

const showAt = (e: React.MouseEvent<HTMLElement>, items: MenuEntry[]) => {
  const r = e.currentTarget.getBoundingClientRect()
  showContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, items)
}

/** Section edits snap to the nearest bar (through tempo and time changes), while the Waveform Grid is on. */
function snapToBar(song: Song, t: number) {
  if (!getSettings().waveformGrid) return Math.max(0, t)
  return Math.max(0, nearestBar(song, t))
}

type Edit = (label: string, change: () => void) => void

function insertAt(song: Song, at: number, typeIndex: number, edit: Edit) {
  const t = Math.min(song.duration - 0.1, Math.max(0, at))
  if (song.sections.some((s) => Math.abs(s.start - t) < 0.05)) return
  const name = nextSectionName(SECTION_TYPES[typeIndex], song.sections)
  edit(`Add Section “${name}”`, () => {
    song.sections.push({ id: uid('sec'), name, start: t })
    song.sections.sort((a, b) => a.start - b.start)
  })
}

const typeItems = (onPick: (i: number) => void): MenuItem[] => SECTION_TYPES.map((t, i) => ({ label: t.name, onClick: () => onPick(i) }))

/** + after a section: the new one splits it at the playhead if that's inside it, else at its middle bar. */
function insertMenu(song: Song, i: number, engine: Engine, edit: Edit): MenuItem[] {
  const start = song.sections[i].start
  const end = sectionEnd(song, i)
  const pos = engine.position
  const at = pos > start + 0.05 && pos < end - 0.05 ? snapToBar(song, pos) : snapToBar(song, (start + end) / 2)
  const split = at > start + 0.05 && at < end - 0.05 ? at : (start + end) / 2
  return typeItems((t) => insertAt(song, split, t, edit))
}

function addAtPlayhead(song: Song, engine: Engine, edit: Edit): MenuItem[] {
  return typeItems((t) => insertAt(song, snapToBar(song, engine.position), t, edit))
}

/**
 * Cuts a section: its music is left out, and the song plays that much shorter. Straight away (like
 * deleting a slide in Lumen), and undoable; the ✂ where it was puts it back.
 */
function cutSection(song: Song, i: number, edit: Edit) {
  if (song.sections.filter((s) => !s.skip).length < 2) return
  const s = song.sections[i]
  edit(`Cut “${s.name}”`, () => (s.skip = true))
  showNote(`Cut “${s.name}”: the song is ${formatTime(sectionEnd(song, i) - s.start)} shorter. ${UNDO_KEY} undoes this.`, true)
}

/** Puts cut sections' music back. */
function putBack(sections: Section[], edit: Edit) {
  edit(sections.length === 1 ? `Put Back “${sections[0].name}”` : 'Put Back Sections', () => sections.forEach((s) => delete s.skip))
}

/** Takes the marker out but keeps the music: its time joins the section before. */
function removeMarker(song: Song, i: number, edit: Edit) {
  if (song.sections.length < 2) return
  const name = song.sections[i].name
  edit(`Remove Marker “${name}”`, () => {
    song.sections.splice(i, 1)
    song.sections[0].start = 0
  })
  showNote(`Removed the marker “${name}”; its music joins the section before. ${UNDO_KEY} undoes this.`, true)
}

/** A section's loop button cycles: off → repeat once → repeat until turned off → off. */
function loopTitle(name: string, mode: LoopMode | null) {
  if (mode === 'once') return `Repeating ${name} once (click to repeat it until turned off)`
  if (mode === 'forever') return `Repeating ${name} until turned off (click to stop)`
  return `Repeat ${name} once (click twice to repeat it until turned off)`
}

function sectionMenu(song: Song, i: number, engine: Engine, edit: Edit, looping: LoopMode | null): MenuEntry[] {
  const s = song.sections[i]
  return [
    { label: `${looping === 'once' ? '✓ ' : ''}Repeat Once`, onClick: () => engine.toggleLoop(s.id, 'once') },
    { label: `${looping === 'forever' ? '✓ ' : ''}Repeat Until Turned Off`, onClick: () => engine.toggleLoop(s.id, 'forever') },
    { label: 'Add Section After', submenu: insertMenu(song, i, engine, edit) },
    { label: 'Change To', submenu: typeItems((t) => edit('Rename Section', () => (s.name = nextSectionName(SECTION_TYPES[t], song.sections.filter((x) => x !== s))))) },
    {
      label: 'Rename…',
      onClick: () =>
        void promptDialog({ title: 'Rename Section', defaultValue: s.name, confirmLabel: 'Rename' }).then(
          (name) => name && edit('Rename Section', () => (s.name = name)),
        ),
    },
    {
      label: 'Move Start to Playhead',
      disabled: i === 0,
      onClick: () =>
        edit('Move Section', () => {
          s.start = engine.position
          song.sections.sort((a, b) => a.start - b.start)
        }),
    },
    'separator',
    {
      label: 'Cut Section (Leave Out Its Music)',
      danger: true,
      disabled: song.sections.filter((x) => !x.skip).length < 2,
      onClick: () => cutSection(song, i, edit),
    },
    {
      // Its time joins the section before, so not when that one is cut (the music would go with it).
      label: 'Remove Marker Only (Keep the Music)',
      disabled: song.sections.length < 2 || !!song.sections[i - 1]?.skip || (i === 0 && !!song.sections[1]?.skip),
      onClick: () => removeMarker(song, i, edit),
    },
  ]
}

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
)
const PlusIcon = () => icon('M12 6v12M6 12h12')
const MinusIcon = () => icon('M7 12h10')
