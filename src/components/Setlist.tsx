import { useRef } from 'react'
import type { Song } from '../audio/types'
import { type MenuEntry, showContextMenu } from './Ask'

interface Props {
  /** The current setlist's songs, in order. */
  songs: Song[]
  currentId: string | null
  onSelect: (id: string) => void
  onImport: (files: File[]) => void
  /** Replaces the browser file picker (desktop uses a native dialog). */
  onImportClick?: () => void
  /** Takes the song at this position out of the setlist (it stays in the library). */
  onRemove: (index: number) => void
  onMove: (index: number, dir: -1 | 1) => void
  /** Asks, then deletes the song from the library. */
  onDelete: (song: Song) => void
  /** Setlist edit mode: show the move / remove controls. */
  editing: boolean
}

export function Setlist({ songs, currentId, onSelect, onImport, onImportClick, onRemove, onMove, onDelete, editing }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const menu = (s: Song, i: number): MenuEntry[] => [
    { label: 'Load', onClick: () => onSelect(s.id) },
    'separator',
    { label: 'Move Left', disabled: i === 0, onClick: () => onMove(i, -1) },
    { label: 'Move Right', disabled: i === songs.length - 1, onClick: () => onMove(i, 1) },
    { label: 'Remove from Setlist', onClick: () => onRemove(i) },
    'separator',
    { label: 'Delete from Library…', danger: true, onClick: () => onDelete(s) },
  ]
  return (
    <div className="setlist">
      {songs.map((s, i) => (
        <div
          key={`${s.id}-${i}`}
          className={`song-card ${s.id === currentId ? 'active' : ''}`}
          onContextMenu={(e) => showContextMenu(e, menu(s, i))}
        >
          <button className="song-card-main" onClick={() => onSelect(s.id)} title={s.title}>
            <img src={s.artwork} alt="" />
            <div className="song-card-text">
              <div className="song-card-title">{s.title}</div>
              <div className="song-card-meta">
                <span className="song-key">{s.key}</span> {Math.round(s.bpm)} BPM
              </div>
            </div>
            <div className="song-card-index">{i + 1}</div>
          </button>
          {editing && (
            <div className="song-card-tools">
              <button onClick={() => onMove(i, -1)} disabled={i === 0} title="Move left">
                ◀
              </button>
              <button onClick={() => onMove(i, 1)} disabled={i === songs.length - 1} title="Move right">
                ▶
              </button>
              <button onClick={() => onRemove(i)} title="Remove from setlist (stays in the library)">
                ✕
              </button>
            </div>
          )}
        </div>
      ))}
      {songs.length === 0 && <div className="setlist-empty">This setlist is empty. Open the Setlists menu to add songs.</div>}
      <button
        className="song-card add"
        onClick={() => (onImportClick ? onImportClick() : input.current?.click())}
        title="Import stems as a new song"
      >
        <span className="add-plus">+</span>
        <span>Import stems</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,.wav,.wave,.bwf,.rf64,.mp3,.m4a,.aif,.aiff,.flac,.ogg"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) onImport(files)
        }}
      />
    </div>
  )
}
