import { useRef } from 'react'
import type { Song } from '../audio/types'

interface Props {
  songs: Song[]
  currentId: string | null
  onSelect: (id: string) => void
  onImport: (files: File[]) => void
  onRemove: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  editMode: boolean
}

export function Setlist({ songs, currentId, onSelect, onImport, onRemove, onMove, editMode }: Props) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="setlist">
      {songs.map((s, i) => (
        <div key={s.id} className={`song-card ${s.id === currentId ? 'active' : ''}`}>
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
          {editMode && (
            <div className="song-card-tools">
              <button onClick={() => onMove(s.id, -1)} disabled={i === 0} title="Move left">
                ◀
              </button>
              <button onClick={() => onMove(s.id, 1)} disabled={i === songs.length - 1} title="Move right">
                ▶
              </button>
              <button onClick={() => onRemove(s.id)} title="Remove from setlist">
                ✕
              </button>
            </div>
          )}
        </div>
      ))}
      <button className="song-card add" onClick={() => input.current?.click()} title="Import stems as a new song">
        <span className="add-plus">+</span>
        <span>Import stems</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.aif,.aiff,.flac,.ogg"
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
