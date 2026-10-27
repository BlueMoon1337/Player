import { useState } from 'react'
import { confirmDialog } from './Ask'
import { REPOSITORY_NAME, checkForUpdates, installUpdate, progressText, saveToken, useUpdates } from '../platform/updates'

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'
const UNQUARANTINE = 'xattr -dr com.apple.quarantine /Applications/Player.app'

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="small"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

/** macOS is running Player from a read-only copy (App Translocation): how to stop it, once. */
function TranslocatedNotice() {
  return (
    <div className="update-blocked">
      <b>macOS is running Player from a temporary, read-only copy, so updates can’t install.</b> It does that to apps downloaded
      from the internet until they’re cleared. Once:
      <ol className="update-steps">
        <li>Quit Player. Make sure Player is in your Applications folder (drag it there from the disk image if you opened it from there).</li>
        <li>
          Open Terminal (Applications ▸ Utilities), paste this and press Return:
          <code className="update-command">{UNQUARANTINE}</code>
          <CopyButton text={UNQUARANTINE} label="Copy Command" />
        </li>
        <li>Open Player from Applications and click Update again.</li>
      </ol>
    </div>
  )
}

const BLOCKER_TEXT: Record<string, string> = {
  development: 'This is a development build, so updates can be checked but not installed.',
  'not-appimage': 'Updates install into the AppImage version of Player on Linux.',
}

/** Pasting the read-only GitHub token Player downloads updates with. */
function TokenForm({ onDone, replacing }: { onDone?: () => void; replacing: boolean }) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="update-token"
      onSubmit={(e) => {
        e.preventDefault()
        setSaving(true)
        setError(null)
        saveToken(token)
          .then(() => onDone?.())
          .catch((err: Error) => setError(err.message))
          .finally(() => setSaving(false))
      }}
    >
      {!replacing && (
        <p>
          New versions of Player come from <b>{REPOSITORY_NAME}</b> on GitHub. The repository is private, so Player needs a read-only
          token to download them. Make one once:
        </p>
      )}
      <ol className="update-steps">
        <li>
          Open{' '}
          <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">
            {TOKEN_PAGE}
          </a>{' '}
          <CopyButton text={TOKEN_PAGE} label="Copy Link" /> in your browser, signed in to GitHub.
        </li>
        <li>
          Name it “Player updates”, set <b>Expiration</b> to the longest there is, and under <b>Repository access</b> choose{' '}
          <b>Only select repositories</b> ▸ <b>Player</b>.
        </li>
        <li>
          Under <b>Permissions ▸ Repository permissions</b>, set <b>Contents</b> to <b>Read-only</b>. Nothing else.
        </li>
        <li>
          <b>Generate token</b>, copy it, and paste it here.
        </li>
      </ol>
      <div className="update-token-row">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="github_pat_…"
          aria-label="GitHub token"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="primary" disabled={!token.trim() || saving}>
          {saving ? 'Checking…' : 'Save'}
        </button>
      </div>
      {error && <p className="update-error">{error}</p>}
      <p className="hint">Player keeps the token on this computer only, in its settings folder.</p>
    </form>
  )
}

/** The Update window: what version this is, whether there's a newer one, and installing it. */
export function UpdateDialog({ onClose, playing }: { onClose: () => void; playing: boolean }) {
  const u = useUpdates()
  const [replacing, setReplacing] = useState(false)
  const busy = u.status === 'installing'

  const install = async () => {
    const ok = await confirmDialog({
      title: `Install Player ${u.found?.version}?`,
      message: `Player will download it, install it and restart${
        playing ? ', which stops the audio that’s playing now' : ''
      }. Your songs, setlists and settings stay as they are.`,
      confirmLabel: 'Install and Restart',
    })
    if (ok) void installUpdate()
  }

  return (
    <div className="menu-backdrop center" onClick={busy ? undefined : onClose}>
      <div className="dialog update-dialog" role="dialog" aria-label="Update" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3>Update</h3>
          {!busy && (
            <button className="dialog-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>
        <div className="update-current">
          <img src="./icon.svg" alt="" />
          <span className="update-app">Player</span>
          <span className="muted">Version {u.version ?? '…'}</span>
        </div>
        {u.hasToken === false || replacing ? (
          <TokenForm replacing={replacing} onDone={() => setReplacing(false)} />
        ) : (
          <>
            {u.status === 'checking' && <p className="update-status">Checking for updates…</p>}
            {(u.status === 'none' || u.status === 'idle') && (
              <p className="update-status">
                {u.status === 'none' ? 'Player is up to date.' : 'Check whether there’s a newer version.'}
                {u.checkedAt && (
                  <span className="muted">
                    {' '}
                    Checked {new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
                  </span>
                )}
              </p>
            )}
            {u.blocker === 'translocated' && <TranslocatedNotice />}
            {u.blocker && BLOCKER_TEXT[u.blocker] && <p className="update-blocked">{BLOCKER_TEXT[u.blocker]}</p>}
            {u.status === 'error' && <p className="update-error">{u.error}</p>}
            {(u.status === 'available' || u.status === 'installing') && u.found && (
              <div className="update-found">
                <div className="update-found-head">
                  <b>Player {u.found.version}</b> is available
                  {u.found.date && <span className="muted"> · {u.found.date}</span>}
                </div>
                {u.found.notes && <pre className="update-notes">{u.found.notes}</pre>}
              </div>
            )}
            {u.status === 'installing' && u.progress && (
              <div className="update-progress">
                <progress
                  value={u.progress.total ? u.progress.received : undefined}
                  max={u.progress.total ?? undefined}
                  aria-label="Download progress"
                />
                <span className="muted">
                  {u.progress.total && u.progress.received >= u.progress.total ? 'Installing…' : `Downloading ${progressText(u.progress)}`}
                </span>
              </div>
            )}
            <div className="dialog-actions">
              <button className="link" disabled={busy} onClick={() => setReplacing(true)}>
                Change Token…
              </button>
              <span className="dialog-actions-spacer" />
              {u.status === 'available' || u.status === 'installing' ? (
                <button className="primary" disabled={busy || !!u.blocker} onClick={() => void install()}>
                  {busy ? 'Installing…' : 'Install and Restart'}
                </button>
              ) : (
                <button className="primary" disabled={u.status === 'checking'} onClick={() => void checkForUpdates()}>
                  Check Now
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
