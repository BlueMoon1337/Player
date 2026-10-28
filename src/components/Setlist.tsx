import { useRef } from 'react'
import type { Song } from '../audio/types'
import type { SongEnd } from '../platform/types'
import { type MenuEntry, showContextMenu } from './Ask'

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
  /** Asks, then deletes the song from the library. */
  onDelete: (song: Song) => void
  /** Edit mode ("Setlist / Song Map"): Playback's big cards with their controls. */
  editing: boolean
  /** What happens when each song ends, and changing it. */
  songEnd: (songId: string) => SongEnd
  onSongEnd: (songId: string, end: SongEnd) => void
  /** Opens the library to put a song at this position (the end when omitted). */
  onAddSong: (index?: number) => void
  onSongSettings: (songId: string) => void
}

const END_NEXT: Record<SongEnd, SongEnd> = { stop: 'next', next: 'loop', loop: 'stop' }
const END_LABEL: Record<SongEnd, string> = {
  stop: 'Stops at the end (click to continue into the next song)',
  next: 'Continues into the next song (click to loop this song)',
  loop: 'Loops this song (click to stop at the end)',
}

function EndIcon({ end }: { end: SongEnd }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {end === 'next' && <path d="M4 12h12M12 7l5 5-5 5" />}
      {end === 'loop' && <path d="M8 8H5V5M5.6 8.4A7 7 0 1 1 5 13" />}
      {end === 'stop' && <rect x="7" y="7" width="10" height="10" rx="1.5" />}
    </svg>
  )
}

export function Setlist(p: Props) {
  const { songs, currentId, onSelect, onImport, onImportClick, onRemove, onMove, onDelete, editing } = p
  const input = useRef<HTMLInputElement>(null)
  const menu = (s: Song, i: number): MenuEntry[] => [
    { label: 'Load', onClick: () => onSelect(s.id) },
    { label: 'Song Settings…', onClick: () => p.onSongSettings(s.id) },
    'separator',
    { label: 'Move Left', disabled: i === 0, onClick: () => onMove(i, -1) },
    { label: 'Move Right', disabled: i === songs.length - 1, onClick: () => onMove(i, 1) },
    { label: 'Remove from Setlist', onClick: () => onRemove(i) },
    'separator',
    { label: 'Delete from Library…', danger: true, onClick: () => onDelete(s) },
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
      <div className="setlist editing">
        {songs.map((s, i) => {
          const end = p.songEnd(s.id)
          return (
            <div key={`${s.id}-${i}`} className={`ecard-wrap ${s.id === currentId ? 'active' : ''}`}>
              <div className="ecard" onContextMenu={(e) => showContextMenu(e, menu(s, i))} onDoubleClick={() => onSelect(s.id)}>
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
                  className={`ec-btn ec-end end-${end}`}
                  title={END_LABEL[end]}
                  aria-label={END_LABEL[end]}
                  onClick={() => p.onSongEnd(s.id, END_NEXT[end])}
                >
                  <EndIcon end={end} />
                </button>
                {i < songs.length - 1 && (
                  <button className="ec-btn ec-insert" title="Add a song here" onClick={() => p.onAddSong(i + 1)}>
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
        <div className="ecard-wrap">
          <button className="ecard ecard-add" onClick={() => p.onAddSong()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Add a Song</span>
          </button>
          <div className="ecard-title placeholder" />
        </div>
        {picker}
      </div>
    )
  }

  return (
    <div className="setlist">
      {songs.map((s, i) => (
        <div
          key={`${s.id}-${i}`}
          className={`song-card ${s.id === currentId ? 'active' : ''}`}
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
      {songs.length === 0 && <div className="setlist-empty">This setlist is empty. Open the Setlists menu to add songs.</div>}
      <button
        className="song-card add"
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
