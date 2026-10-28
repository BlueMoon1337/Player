import { useRef, useState } from 'react'
import type { Song } from '../audio/types'
import type { SongEnd, SongEndSetting } from '../platform/types'
import { SONG_DRAG } from '../library/store'
import { type MenuEntry, showContextMenu } from './Ask'
import { Popover } from './Popover'

interface Props {
  /** The current setlist's songs, in order. */
  songs: Song[]
  currentId: string | null
  playing: boolean
  onSelect: (id: string) => void
  onImport: (files: File[]) => void
  /** Replaces the browser file picker (desktop uses a native dialog). */
  onImportClick?: () => void
  /** Takes the song at this position out of the setlist (it stays in the library). */
  onRemove: (index: number) => void
  onMove: (index: number, dir: -1 | 1) => void
  /** A library song dropped on the setlist, to go in at this position. */
  onDropSong: (songId: string, index: number) => void
  /** Edit mode: a card dragged to another place in the setlist (`to` is its new index). */
  onReorder: (from: number, to: number) => void
  /** Edit mode ("Setlist / Song Map"): Playback's big cards with their controls. */
  editing: boolean
  /** What happens when each song ends, and changing it. */
  songEnd: (songId: string) => SongEndSetting
  onSongEnd: (songId: string, patch: Partial<SongEndSetting>) => void
  /** Opens the library, beside the + pressed, to put a song at this position (the end when omitted). */
  onAddSong: (index: number | undefined, anchor: DOMRect) => void
  onSongSettings: (songId: string) => void
}

/** Drag type for a card being moved within the setlist (edit mode). */
const CARD_DRAG = 'application/x-player-setlist-card'

/** 'first' is how Cue reads after the last song: Cue First Song. */
type EndIconKind = SongEnd | 'first' | 'pad'

const END_LABEL: Record<EndIconKind, string> = {
  cue: 'Cue Next Song',
  first: 'Cue First Song',
  stay: 'Stay In Song',
  pad: 'Continue Pad',
  link: 'AutoLink',
  overlap: 'Overlap',
  crossfade: 'Crossfade',
}

const END_HINT: Record<EndIconKind, string> = {
  cue: 'At the end, the next song is loaded, ready to play',
  first: 'At the end, the first song is loaded, ready to play',
  stay: 'At the end, this song stays loaded',
  pad: 'At the end, the pad comes on',
  link: 'At the end, the next song starts playing',
  overlap: 'The next song starts at this one’s last section, which plays out underneath',
  crossfade: 'The next song starts at this one’s last section as this one fades out',
}

export function EndIcon({ kind }: { kind: EndIconKind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`end-icon end-icon-${kind}`}>
      {kind === 'cue' && (
        <>
          <path d="M3 12h2.5M8.5 12H15" />
          <path className="fill" d="M14 7.5l6.5 4.5-6.5 4.5z" />
        </>
      )}
      {kind === 'stay' && (
        <>
          <path d="M2.5 12h2M7 12h5" />
          <path className="fill" d="M11.5 8l5.5 4-5.5 4z" />
          <path d="M20 6.5v11" />
        </>
      )}
      {kind === 'first' && (
        <>
          <path d="M9.5 4.5L6 8l3.5 3.5" />
          <path d="M6.5 8h8a4.5 4.5 0 0 1 0 9H11" />
          <circle className="fill" cx="6.3" cy="17" r="1.7" />
        </>
      )}
      {kind === 'pad' && <circle cx="12" cy="12" r="8" />}
      {kind === 'link' && (
        <>
          <rect x="2.5" y="8" width="11" height="8" rx="4" />
          <rect x="10.5" y="8" width="11" height="8" rx="4" />
        </>
      )}
      {kind === 'overlap' && <path d="M4 6h8.5a2.5 2.5 0 0 1 0 5h-2M13.5 13h-2a2.5 2.5 0 0 0 0 5H20" />}
      {kind === 'crossfade' && <path d="M4 5c7.5 0 8.5 14 16 14M4 19c7.5 0 8.5-14 16-14" />}
    </svg>
  )
}

/** As it reads on the card: after the last song, Cue means the first song, and only Stay is kept. */
const shownEnd = (s: SongEndSetting, last: boolean): EndIconKind =>
  last ? (s.end === 'stay' ? 'stay' : 'first') : s.end

/** Playback's end-of-song popover, beside the button on a song's card. */
function EndMenu({
  anchor,
  setting,
  last,
  onChange,
  onClose,
}: {
  anchor: DOMRect
  setting: SongEndSetting
  last: boolean
  onChange: (patch: Partial<SongEndSetting>) => void
  onClose: () => void
}) {
  const current = shownEnd(setting, last)
  const choice = (kind: EndIconKind, end: SongEnd) => (
    <button
      key={kind}
      role="menuitemradio"
      aria-checked={current === kind}
      className="em-row"
      title={END_HINT[kind]}
      onClick={() => {
        onChange({ end })
        onClose()
      }}
    >
      <EndIcon kind={kind} />
      <span className="em-label">{END_LABEL[kind]}</span>
      {current === kind && (
        <svg className="em-check" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7" />
        </svg>
      )}
    </button>
  )

  return (
    <Popover anchor={anchor} className="end-menu" ignore=".ec-end.open" onClose={onClose}>
      {choice(last ? 'first' : 'cue', 'cue')}
      {choice('stay', 'stay')}
      <label className="em-row em-pad" title={END_HINT.pad}>
        <EndIcon kind="pad" />
        <span className="em-label">{END_LABEL.pad}</span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={setting.continuePad}
          onChange={(e) => onChange({ continuePad: e.target.checked })}
        />
      </label>
      {!last && (
        <>
          {choice('link', 'link')}
          {choice('overlap', 'overlap')}
          {choice('crossfade', 'crossfade')}
        </>
      )}
    </Popover>
  )
}

export function Setlist(p: Props) {
  const { songs, currentId, onSelect, onImport, onImportClick, onRemove, onMove, editing } = p
  const input = useRef<HTMLInputElement>(null)
  /** The end-of-song popover: which card (by position) and where its button is. */
  const [endMenu, setEndMenu] = useState<{ index: number; anchor: DOMRect } | null>(null)
  /** Where a song being dragged in (or a card being moved) would go: before the card at this index. */
  const [dropAt, setDropAt] = useState<number | null>(null)
  /** Edit mode: the card being dragged to a new place. */
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  /**
   * Drops go before the first card whose middle is right of the pointer. A song from the library
   * is added there; a card dragged in edit mode moves there.
   */
  const dropProps = {
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
      const moving = dragFrom !== null && e.dataTransfer.types.includes(CARD_DRAG)
      if (!moving && !e.dataTransfer.types.includes(SONG_DRAG)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = moving ? 'move' : 'copy'
      const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-index]')]
      const at = cards.find((c) => {
        const r = c.getBoundingClientRect()
        return e.clientX < r.left + r.width / 2
      })
      const to = at ? Number(at.dataset.index) : songs.length
      // Right before or after the card being moved leaves it where it is: no marker.
      setDropAt(moving && (to === dragFrom || to === dragFrom! + 1) ? null : to)
    },
    onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
    },
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const at = dropAt
      setDropAt(null)
      if (dragFrom !== null && e.dataTransfer.types.includes(CARD_DRAG)) {
        if (at !== null) p.onReorder(dragFrom, at > dragFrom ? at - 1 : at)
        setDragFrom(null)
        return
      }
      const id = e.dataTransfer.getData(SONG_DRAG)
      if (id) p.onDropSong(id, at ?? songs.length)
    },
  }
  const dropClass = (i: number) => (dropAt === i ? 'drop-before' : '')
  const menu = (s: Song, i: number): MenuEntry[] => [
    { label: 'Load', onClick: () => onSelect(s.id) },
    { label: 'Song Settings…', onClick: () => p.onSongSettings(s.id) },
    'separator',
    { label: 'Move Left', disabled: i === 0, onClick: () => onMove(i, -1) },
    { label: 'Move Right', disabled: i === songs.length - 1, onClick: () => onMove(i, 1) },
    { label: 'Remove from Setlist', onClick: () => onRemove(i) },
  ]
  const picker = (
    <input
      ref={input}
      type="file"
      accept="audio/*,.wav,.wave,.bwf,.rf64,.mp3,.m4a,.aif,.aiff,.flac,.ogg,.zip,application/zip"
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ''
        if (files.length) onImport(files)
      }}
    />
  )

  if (editing) {
    return (
      <div className="setlist editing" {...dropProps}>
        {songs.map((s, i) => {
          const setting = p.songEnd(s.id)
          const end = shownEnd(setting, i === songs.length - 1)
          return (
            <div
              key={`${s.id}-${i}`}
              data-index={i}
              className={`ecard-wrap ${s.id === currentId ? 'active' : ''} ${dropClass(i)} ${dragFrom === i ? 'dragging' : ''}`}
            >
              <div
                className="ecard"
                title="Drag to move it in the setlist"
                draggable
                onDragStart={(e) => {
                  setEndMenu(null)
                  setDragFrom(i)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(CARD_DRAG, String(i))
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDropAt(null)
                }}
                onContextMenu={(e) => showContextMenu(e, menu(s, i))}
                onDoubleClick={() => onSelect(s.id)}
              >
                <img className="ecard-art" src={s.artwork} alt="" draggable={false} />
                <button className="ec-btn ec-remove" title="Remove from setlist (stays in the library)" onClick={() => onRemove(i)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 12h10" />
                  </svg>
                </button>
                <button
                  className="ec-btn ec-more"
                  title="More"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    showContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, menu(s, i))
                  }}
                >
                  •••
                </button>
                <button
                  className={`ec-btn ec-end end-${end} ${setting.continuePad ? 'pad' : ''} ${endMenu?.index === i ? 'open' : ''}`}
                  title={`At the end: ${END_LABEL[end]}${setting.continuePad ? ', Continue Pad' : ''}`}
                  aria-label={`At the end: ${END_LABEL[end]}`}
                  aria-haspopup="menu"
                  onClick={(e) =>
                    setEndMenu(endMenu?.index === i ? null : { index: i, anchor: e.currentTarget.getBoundingClientRect() })
                  }
                >
                  <EndIcon kind={end} />
                </button>
                {i < songs.length - 1 && (
                  <button className="ec-btn ec-insert" title="Add a song here" onClick={(e) => p.onAddSong(i + 1, e.currentTarget.getBoundingClientRect())}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 6v12M6 12h12" />
                    </svg>
                  </button>
                )}
              </div>
              <button className="ecard-title" onClick={() => onSelect(s.id)} title={s.artist ? `${s.title} — ${s.artist}` : s.title}>
                {s.id === currentId && (
                  <svg className={`ecard-playing ${p.playing ? 'on' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 5v14l11-7z" />
                  </svg>
                )}
                <span className="ecard-name">{s.title}</span>
                <span className="ecard-key">({s.key})</span>
              </button>
            </div>
          )
        })}
        <div className={`ecard-wrap ${dropClass(songs.length)}`}>
          <button className="ecard ecard-add" onClick={(e) => p.onAddSong(undefined, e.currentTarget.getBoundingClientRect())}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Add a Song</span>
          </button>
          <div className="ecard-title placeholder" />
        </div>
        {picker}
        {endMenu && songs[endMenu.index] && (
          <EndMenu
            anchor={endMenu.anchor}
            setting={p.songEnd(songs[endMenu.index].id)}
            last={endMenu.index === songs.length - 1}
            onChange={(patch) => p.onSongEnd(songs[endMenu.index].id, patch)}
            onClose={() => setEndMenu(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="setlist" {...dropProps}>
      {songs.map((s, i) => (
        <div
          key={`${s.id}-${i}`}
          data-index={i}
          className={`song-card ${s.id === currentId ? 'active' : ''} ${dropClass(i)}`}
          onContextMenu={(e) => showContextMenu(e, menu(s, i))}
        >
          <button className="song-card-main" onClick={() => onSelect(s.id)} title={s.artist ? `${s.title} — ${s.artist}` : s.title}>
            <img src={s.artwork} alt="" />
            <div className="song-card-text">
              <div className="song-card-title">{s.title}</div>
              <div className="song-card-meta">
                <span className="song-key">{s.key}</span> {Math.round(s.bpm)} BPM
              </div>
            </div>
            <div className="song-card-index">{i + 1}</div>
          </button>
        </div>
      ))}
      {songs.length === 0 && (
        <div className="setlist-empty">This setlist is empty. Open the Setlists menu to add songs, or drag them in.</div>
      )}
      <button
        className={`song-card add ${dropClass(songs.length)}`}
        onClick={() => (onImportClick ? onImportClick() : input.current?.click())}
        title="Import songs: MultiTracks zips, song folders or audio files"
      >
        <span className="add-plus">+</span>
        <span>Import songs</span>
      </button>
      {picker}
    </div>
  )
}
