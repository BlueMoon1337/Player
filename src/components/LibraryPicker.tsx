import { useMemo, useState } from 'react'
import { type Song, formatTime, sectionAbbrev, sectionColor } from '../audio/types'
import { librarySongs, useLibrary } from '../library/store'
import { Popover } from './Popover'

interface Props {
  /** The + it was opened from. */
  anchor: DOMRect
  /** Where the song goes, for the button's label. */
  setlistName: string
  position: number
  onAdd: (songId: string) => void
  onImport: () => void
  onClose: () => void
}

type Page =
  | { kind: 'home' }
  | { kind: 'songs'; title: string; artist?: string | null; album?: string | null }
  | { kind: 'albums' }
  | { kind: 'artists' }
  | { kind: 'song'; id: string }

const UNKNOWN_ARTIST = 'Unknown Artist'
const UNKNOWN_ALBUM = 'Unknown Album'
const RECENT = 5

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Alphabetical, with the "Unknown" group last. */
const byName = (a: string, b: string) =>
  (a.startsWith('Unknown ') ? 1 : 0) - (b.startsWith('Unknown ') ? 1 : 0) || collator.compare(a, b)

/** The letter a name is filed under: accents dropped, digits and symbols under #. */
function letterOf(name: string) {
  const c = name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().charAt(0).toUpperCase()
  return /[A-Z]/.test(c) ? c : '#'
}

interface Group {
  name: string
  songs: Song[]
}

function groupBy(songs: Song[], key: (s: Song) => string): Group[] {
  const groups = new Map<string, Song[]>()
  for (const s of songs) {
    const k = key(s)
    groups.set(k, [...(groups.get(k) ?? []), s])
  }
  return [...groups].map(([name, list]) => ({ name, songs: list })).sort((a, b) => byName(a.name, b.name))
}

const artistOf = (s: Song) => s.artist?.trim() || UNKNOWN_ARTIST
const albumOf = (s: Song) => s.album?.trim() || UNKNOWN_ALBUM

function Chevron() {
  return (
    <svg className="lp-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

/** Rows with a letter heading wherever the first letter changes. */
function Lettered<T>({ items, name, row }: { items: T[]; name: (t: T) => string; row: (t: T) => JSX.Element }) {
  let last = ''
  return (
    <>
      {items.map((t, i) => {
        const l = letterOf(name(t))
        const head = l !== last
        last = l
        return (
          <div key={i}>
            {head && <div className="lp-letter">{l}</div>}
            {row(t)}
          </div>
        )
      })}
    </>
  )
}

/**
 * Playback's Library popover, opened from a + in the setlist: Songs, Albums and Artists, each
 * in alphabetical order, and the songs imported most recently. A song's page adds it to the setlist.
 */
export function LibraryPicker({ anchor, setlistName, position, onAdd, onImport, onClose }: Props) {
  const lib = useLibrary()
  const [pages, setPages] = useState<Page[]>([{ kind: 'home' }])
  const [query, setQuery] = useState<string | null>(null)
  const page = pages[pages.length - 1]
  const go = (p: Page) => setPages((ps) => [...ps, p])
  const back = () => setPages((ps) => (ps.length > 1 ? ps.slice(0, -1) : ps))

  const songs = useMemo(() => librarySongs(lib).sort((a, b) => collator.compare(a.title, b.title)), [lib])
  const albums = useMemo(() => groupBy(songs, albumOf), [songs])
  const artists = useMemo(() => groupBy(songs, artistOf), [songs])
  const recent = useMemo(
    () => songs.filter((s) => s.added).sort((a, b) => b.added! - a.added!).slice(0, RECENT),
    [songs],
  )

  const songRow = (s: Song, sub = s.artist || s.album || `${s.key} · ${Math.round(s.bpm)} BPM`) => (
    <button
      key={s.id}
      className="lp-row lp-song"
      onClick={() => go({ kind: 'song', id: s.id })}
      onDoubleClick={() => onAdd(s.id)}
      title={`${s.title}: double-click to add`}
    >
      <img src={s.artwork} alt="" draggable={false} />
      <span className="lp-text">
        <span className="lp-name">{s.title}</span>
        <span className="lp-sub">{sub}</span>
      </span>
      <Chevron />
    </button>
  )

  const groupRow = (g: Group, kind: 'album' | 'artist') => {
    const artistsHere = new Set(g.songs.map(artistOf))
    const sub =
      kind === 'album' && artistsHere.size === 1 && !artistsHere.has(UNKNOWN_ARTIST)
        ? [...artistsHere][0]
        : `${g.songs.length} song${g.songs.length === 1 ? '' : 's'}`
    return (
      <button
        key={g.name}
        className={`lp-row lp-song ${kind === 'artist' ? 'lp-artist' : ''}`}
        onClick={() =>
          go({ kind: 'songs', title: g.name, [kind]: g.name.startsWith('Unknown ') ? null : g.name })
        }
      >
        <img src={g.songs[0].artwork} alt="" draggable={false} />
        <span className="lp-text">
          <span className="lp-name">{g.name}</span>
          <span className="lp-sub">{sub}</span>
        </span>
        <Chevron />
      </button>
    )
  }

  let title = 'Library'
  let body: JSX.Element
  const q = query?.trim().toLowerCase()
  if (q) {
    title = 'Search'
    const found = songs.filter((s) => [s.title, s.artist, s.album].some((t) => t?.toLowerCase().includes(q)))
    body = found.length ? <>{found.map((s) => songRow(s))}</> : <div className="lp-empty">No songs match “{query}”.</div>
  } else if (page.kind === 'home') {
    body = (
      <>
        <div className="lp-group">
          {(
            [
              ['Songs', { kind: 'songs', title: 'Songs' }, songs.length],
              ['Albums', { kind: 'albums' }, albums.length],
              ['Artists', { kind: 'artists' }, artists.length],
            ] as const
          ).map(([label, to, count]) => (
            <button key={label} className="lp-row" onClick={() => go(to)}>
              <span className="lp-name">{label}</span>
              <span className="lp-count">{count}</span>
              <Chevron />
            </button>
          ))}
        </div>
        {recent.length > 0 && (
          <>
            <div className="lp-heading">Recent</div>
            <div className="lp-group">{recent.map((s) => songRow(s))}</div>
          </>
        )}
        {!songs.length && (
          <div className="lp-empty">
            The library is empty.
            <button className="small" onClick={onImport}>
              Import Songs…
            </button>
          </div>
        )}
      </>
    )
  } else if (page.kind === 'songs') {
    title = page.title
    const list = songs.filter(
      (s) =>
        (page.album === undefined || (page.album === null ? !s.album?.trim() : s.album?.trim() === page.album)) &&
        (page.artist === undefined || (page.artist === null ? !s.artist?.trim() : s.artist?.trim() === page.artist)),
    )
    body =
      page.album === undefined && page.artist === undefined ? (
        <Lettered items={list} name={(s) => s.title} row={(s) => songRow(s)} />
      ) : (
        <>{list.map((s) => songRow(s, page.album !== undefined ? s.artist || `${s.key} · ${Math.round(s.bpm)} BPM` : s.album || `${s.key} · ${Math.round(s.bpm)} BPM`))}</>
      )
  } else if (page.kind === 'albums') {
    title = 'Albums'
    body = <Lettered items={albums} name={(g) => g.name} row={(g) => groupRow(g, 'album')} />
  } else if (page.kind === 'artists') {
    title = 'Artists'
    body = <Lettered items={artists} name={(g) => g.name} row={(g) => groupRow(g, 'artist')} />
  } else {
    const s = lib.songs[page.id]
    title = s?.title ?? 'Song'
    body = s ? (
      <div className="lp-detail">
        <img className="lp-cover" src={s.artwork} alt="" draggable={false} />
        <div className="lp-detail-title">{s.title}</div>
        {(s.artist || s.album) && <div className="lp-sub">{[s.artist, s.album].filter(Boolean).join(' · ')}</div>}
        <div className="lp-facts">
          <span>
            <b>{s.key}</b>Key
          </span>
          <span>
            <b>{Math.round(s.bpm * 10) / 10}</b>BPM
          </span>
          <span>
            <b>
              {s.timeSig[0]}/{s.timeSig[1]}
            </b>
            Time
          </span>
          <span>
            <b>{formatTime(s.duration)}</b>Length
          </span>
        </div>
        {s.sections.length > 0 && (
          <div className="lp-sections" aria-label="Sections">
            {s.sections.map((sec) => (
              <span key={sec.id} title={sec.name} style={{ background: sectionColor(sec.name) }}>
                {sectionAbbrev(sec.name)}
              </span>
            ))}
          </div>
        )}
        <button className="lp-add" onClick={() => onAdd(s.id)}>
          Add to “{setlistName}”
        </button>
        <div className="lp-sub">At position {position + 1}</div>
      </div>
    ) : (
      <div className="lp-empty">This song is no longer in the library.</div>
    )
  }

  return (
    <Popover
      anchor={anchor}
      className="library-picker"
      onClose={onClose}
      onEscape={() => {
        if (query !== null) {
          setQuery(null)
          return true
        }
        if (pages.length > 1) {
          back()
          return true
        }
        return false
      }}
    >
      <header className="lp-head">
        <button
          className="lp-round"
          aria-label={pages.length > 1 && query === null ? 'Back' : 'Close'}
          title={pages.length > 1 && query === null ? 'Back' : 'Close'}
          onClick={() => (query !== null ? setQuery(null) : pages.length > 1 ? back() : onClose())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {pages.length > 1 || query !== null ? <path d="M15 5l-7 7 7 7" /> : <path d="M6 6l12 12M18 6L6 18" />}
          </svg>
        </button>
        <h3>{title}</h3>
        <button
          className={`lp-round lp-search-btn ${query !== null ? 'on' : ''}`}
          aria-label="Search"
          title="Search the library"
          onClick={() => {
            if (query === null) setQuery('')
            else setQuery(null)
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="M15 15l5 5" />
          </svg>
        </button>
      </header>
      {query !== null && (
        <input
          autoFocus
          className="lp-search"
          type="search"
          placeholder="Songs, artists and albums"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="lp-body">{body}</div>
    </Popover>
  )
}
