import { useEffect, useMemo, useRef, useState } from 'react'
import { type Song, formatTime } from '../audio/types'
import { desktop } from '../platform'
import {
  addToSetlist,
  currentSetlist,
  deleteSetlist,
  deleteSong,
  duplicateSetlist,
  getLibrary,
  librarySongs,
  moveInSetlist,
  newSetlist,
  removeFromSetlist,
  renameSetlist,
  setCurrentSetlist,
  setlistSongs,
  setlistsWith,
  useLibrary,
} from '../library/store'
import { type MenuEntry, confirmDialog, isAsking, promptDialog, showContextMenu } from './Ask'

interface Props {
  currentSongId: string | null
  playing: boolean
  onLoadSong: (id: string) => void
  onImport: () => void
  onClose: () => void
}

/** Asks first (it holds a song that may be in setlists or playing), then deletes from the library. */
export async function confirmDeleteSong(song: Song, opts: { playingNow: boolean }) {
  const lists = setlistsWith(song.id).map((s) => `“${s.name}”`)
  const parts: string[] = []
  if (lists.length) parts.push(`It comes out of ${lists.length === 1 ? 'the setlist' : 'the setlists'} ${listText(lists)}.`)
  if (opts.playingNow) parts.push('It’s playing now, so playback stops.')
  parts.push('You can undo this.')
  const ok = await confirmDialog({
    title: `Delete “${song.title}” from the library?`,
    message: parts.join(' '),
    confirmLabel: 'Delete',
    danger: true,
  })
  if (ok) await deleteSong(song.id)
}

/** A setlist that has songs asks first; an empty one goes straight away. Its songs stay in the library. */
export async function confirmDeleteSetlist(id: string) {
  const sl = getLibrary().setlists.find((s) => s.id === id)
  if (!sl) return
  if (sl.songs.length) {
    const ok = await confirmDialog({
      title: `Delete the setlist “${sl.name}”?`,
      message: `Its ${sl.songs.length === 1 ? 'song stays' : `${sl.songs.length} songs stay`} in the library. You can undo this.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
  }
  deleteSetlist(id)
}

export async function askNewSetlist() {
  const name = await promptDialog({ title: 'New Setlist', placeholder: 'Sunday AM', confirmLabel: 'Create' })
  if (name) newSetlist(name)
}

async function askRename(id: string, name: string) {
  const next = await promptDialog({ title: 'Rename Setlist', defaultValue: name, confirmLabel: 'Rename' })
  if (next) renameSetlist(id, next)
}

const listText = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export function SetlistsMenu({ currentSongId, playing, onLoadSong, onImport, onClose }: Props) {
  const lib = useLibrary()
  const current = currentSetlist(lib)
  const [view, setView] = useState<'library' | 'setlist'>('setlist')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const all = useMemo(() => librarySongs(lib), [lib])
  const shown = view === 'library'
    ? all.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
    : setlistSongs(current, lib)

  // Selection follows the list it's in.
  useEffect(() => setSelected(null), [view, current?.id])
  useEffect(() => {
    if (selected !== null && selected >= shown.length) setSelected(shown.length ? shown.length - 1 : null)
  }, [shown.length, selected])

  const deleteSelected = async () => {
    if (selected === null || !shown[selected]) return
    if (view === 'setlist') {
      // Out of the setlist straight away (it stays in the library); the next song is selected.
      removeFromSetlist(current.id, selected)
    } else {
      const song = shown[selected]
      await confirmDeleteSong(song, { playingNow: playing && song.id === currentSongId })
    }
  }

  // Keys: Delete removes the selection, arrows move it, Return loads, Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isAsking() || (e.target as HTMLElement).closest('input, textarea, select')) {
        if (e.key === 'Escape' && (e.target as HTMLElement).closest('input')) (e.target as HTMLElement).blur()
        return
      }
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Delete' || e.key === 'Backspace') void deleteSelected()
      else if (e.key === 'ArrowDown') setSelected((s) => Math.min(shown.length - 1, s === null ? 0 : s + 1))
      else if (e.key === 'ArrowUp') setSelected((s) => Math.max(0, s === null ? 0 : s - 1))
      else if (e.key === 'Enter' && selected !== null && shown[selected]) {
        if (view === 'library') addToSetlist(current.id, [shown[selected].id])
        else onLoadSong(shown[selected].id)
      } else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const songMenu = (song: Song, index: number): MenuEntry[] => {
    const others = lib.setlists.filter((s) => s.id !== current.id)
    const items: MenuEntry[] = [
      { label: 'Load', onClick: () => onLoadSong(song.id) },
      view === 'library'
        ? { label: `Add to “${current.name}”`, onClick: () => addToSetlist(current.id, [song.id]) }
        : { label: 'Remove from Setlist', hint: '⌫', onClick: () => removeFromSetlist(current.id, index) },
    ]
    if (others.length) {
      items.push({
        label: 'Add to Setlist',
        submenu: others.map((sl) => ({ label: sl.name, onClick: () => addToSetlist(sl.id, [song.id]) })),
      })
    }
    if (view === 'setlist') {
      items.push(
        'separator',
        { label: 'Move Up', disabled: index === 0, onClick: () => moveInSetlist(current.id, index, index - 1) },
        { label: 'Move Down', disabled: index === shown.length - 1, onClick: () => moveInSetlist(current.id, index, index + 1) },
      )
    }
    if (desktop && song.source === 'library') {
      items.push('separator', { label: 'Show Files', onClick: () => void desktop!.library.reveal(song.id) })
    }
    items.push('separator', {
      label: 'Delete from Library…',
      hint: view === 'library' ? '⌫' : undefined,
      danger: true,
      onClick: () => void confirmDeleteSong(song, { playingNow: playing && song.id === currentSongId }),
    })
    return items
  }

  const setlistMenu = (id: string, name: string): MenuEntry[] => [
    { label: 'Rename…', onClick: () => void askRename(id, name) },
    { label: 'Duplicate', onClick: () => duplicateSetlist(id) },
    'separator',
    { label: 'Delete Setlist…', danger: true, onClick: () => void confirmDeleteSetlist(id) },
  ]

  return (
    <div className="menu-backdrop center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog setlists" role="dialog" aria-label="Setlists">
        <aside className="sl-side">
          <div className="sl-side-head">Library</div>
          <button className={`sl-side-item ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
            <span>All Songs</span>
            <span className="sl-count">{all.length}</span>
          </button>
          <div className="sl-side-head">
            Setlists
            <button className="sl-add" title="New Setlist" onClick={() => void askNewSetlist()}>
              +
            </button>
          </div>
          <div className="sl-side-list">
            {lib.setlists.map((sl) => (
              <div
                key={sl.id}
                className={`sl-side-item ${view === 'setlist' && sl.id === current.id ? 'active' : ''} ${sl.id === current.id ? 'current' : ''}`}
                onClick={() => {
                  setCurrentSetlist(sl.id)
                  setView('setlist')
                }}
                onDoubleClick={() => void askRename(sl.id, sl.name)}
                onContextMenu={(e) => showContextMenu(e, setlistMenu(sl.id, sl.name))}
                role="button"
                tabIndex={0}
                title={sl.id === current.id ? `${sl.name} (current setlist)` : sl.name}
              >
                <span className="sl-name">{sl.name}</span>
                <span className="sl-count">{sl.songs.length}</span>
                <button
                  className="sl-trash"
                  title="Delete Setlist"
                  onClick={(e) => {
                    e.stopPropagation()
                    void confirmDeleteSetlist(sl.id)
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="sl-main">
          <header className="sl-head">
            <h3>{view === 'library' ? 'Library' : current.name}</h3>
            {view === 'library' ? (
              <input
                className="sl-search"
                type="search"
                placeholder="Search songs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : (
              <span className="muted sl-sub">
                {shown.length} song{shown.length === 1 ? '' : 's'} ·{' '}
                {formatTime(shown.reduce((t, s) => t + s.duration, 0))}
              </span>
            )}
            <span className="dialog-actions-spacer" />
            <button className="small" onClick={onImport}>
              Import Songs…
            </button>
            <button className="dialog-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </header>

          <div className="sl-list" ref={listRef} role="listbox" aria-label={view === 'library' ? 'Library' : current.name}>
            {shown.map((song, i) => {
              const inSetlist = view === 'library' ? current.songs.includes(song.id) : false
              return (
                <div
                  key={`${song.id}-${i}`}
                  role="option"
                  aria-selected={selected === i}
                  className={`sl-row ${view === 'library' ? 'lib' : ''} ${selected === i ? 'selected' : ''} ${song.id === currentSongId ? 'loaded' : ''} ${
                    dropAt === i && dragFrom !== null ? (dragFrom < i ? 'drop-after' : 'drop-before') : ''
                  }`}
                  onClick={() => setSelected(i)}
                  onDoubleClick={() => (view === 'library' ? addToSetlist(current.id, [song.id]) : onLoadSong(song.id))}
                  onContextMenu={(e) => {
                    setSelected(i)
                    showContextMenu(e, songMenu(song, i))
                  }}
                  draggable={view === 'setlist'}
                  onDragStart={(e) => {
                    setDragFrom(i)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', String(i))
                  }}
                  onDragOver={(e) => {
                    if (dragFrom === null) return
                    e.preventDefault()
                    setDropAt(i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragFrom !== null) {
                      moveInSetlist(current.id, dragFrom, i)
                      setSelected(i)
                    }
                    setDragFrom(null)
                    setDropAt(null)
                  }}
                  onDragEnd={() => {
                    setDragFrom(null)
                    setDropAt(null)
                  }}
                >
                  {view === 'setlist' && <span className="sl-num">{i + 1}</span>}
                  <img src={song.artwork} alt="" />
                  <span className="sl-title">
                    {song.title}
                    {song.artist && <span className="sl-artist">{song.artist}</span>}
                    {song.id === currentSongId && <span className="sl-loaded">{playing ? 'Playing' : 'Loaded'}</span>}
                  </span>
                  <span className="sl-key">{song.key}</span>
                  <span className="sl-meta">{Math.round(song.bpm)} BPM</span>
                  <span className="sl-meta">{formatTime(song.duration)}</span>
                  {view === 'library' ? (
                    <button
                      className={`small sl-action ${inSetlist ? 'in' : ''}`}
                      title={inSetlist ? `Already in “${current.name}” (add again)` : `Add to “${current.name}”`}
                      onClick={(e) => {
                        e.stopPropagation()
                        addToSetlist(current.id, [song.id])
                      }}
                    >
                      {inSetlist ? '✓ Added' : '+ Add'}
                    </button>
                  ) : (
                    <button
                      className="sl-icon"
                      title="Remove from Setlist"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFromSetlist(current.id, i)
                      }}
                    >
                      −
                    </button>
                  )}
                  <button
                    className="sl-icon sl-trash"
                    title="Delete from Library"
                    onClick={(e) => {
                      e.stopPropagation()
                      void confirmDeleteSong(song, { playingNow: playing && song.id === currentSongId })
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )
            })}
            {shown.length === 0 && (
              <div className="sl-empty">
                {view === 'library' ? (
                  query ? (
                    'No songs match.'
                  ) : (
                    'The library is empty. Import some songs.'
                  )
                ) : (
                  <>
                    This setlist is empty.
                    <button className="small" onClick={() => setView('library')}>
                      Add Songs from the Library
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {view === 'setlist' && shown.length > 0 && (
            <footer className="sl-foot">
              <button className="small" onClick={() => setView('library')}>
                + Add Songs
              </button>
              <span className="muted">Drag to reorder · Double-click to load · ⌫ removes from the setlist</span>
            </footer>
          )}
        </section>
      </div>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1.5v-8H10zm3.5 0v8H15v-8h-1.5z"
        fill="currentColor"
      />
    </svg>
  )
}
