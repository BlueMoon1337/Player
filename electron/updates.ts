// The Update button: new versions of Player come from the GitHub repository's releases, which a
// GitHub Actions workflow builds and signs (.github/workflows/release.yml). The repository is
// private, so Player downloads with a read-only GitHub token pasted in once; it's kept in a file
// of its own in Player's settings folder and never handed to the page.
//
// Each release carries latest.json: the version, its notes, and the files to download, each with
// its SHA-512 and an Ed25519 signature over both:
// - "interface": an update package (npm run update-package): Player without Electron, the same
//   for every platform. Made and published without a build machine (npm run publish-package),
//   so it's what most releases carry. Taken when this copy's Electron fits it.
// - "platforms": a whole app for each platform, from the Release workflow (run by hand).
// Player refuses any download whose hash or signature doesn't match the public key below,
// installs it (keeping this version for Go Back: electron/packages.ts) and restarts.

import { type BrowserWindow, app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
// Electron's fs treats .asar files as folders; this one deletes an unpacked package's app.asar as the file it is.
import ofs from 'original-fs'
import publicKeyPem from './update-key.pem'
import * as packages from './packages'
import { newer, shellFits, signedMessage } from './packages'

export { newer, signedMessage }

/** Where releases come from. */
export const REPOSITORY = 'BlueMoon1337/Player'

const PUBLIC_KEY = createPublicKey(publicKeyPem)

export interface Found {
  version: string
  current: string
  notes: string | null
  date: string | null
}

interface PlatformEntry {
  file: string
  sha512: string
  signature: string
}

interface Manifest {
  version: string
  notes?: string
  date?: string
  platforms?: Partial<Record<string, PlatformEntry>>
  /** An update package for every platform; `electron` is the Electron it was built with. */
  interface?: PlatformEntry & { electron?: string }
}

interface Asset {
  name: string
  /** The API address, which downloads with the token (the browser address doesn't, for a private repository). */
  url: string
}

/** GitHub's API, or a stand-in for trying updates (signatures are checked either way). */
function api() {
  return (process.env.PLAYER_UPDATE_API || 'https://api.github.com').replace(/\/$/, '')
}

const tokenPath = () => path.join(app.getPath('userData'), 'update-token')

function readToken(): string | null {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim()
    return t || null
  } catch {
    return null
  }
}

export function hasToken() {
  return readToken() !== null
}

/** Keeps the GitHub token (readable only by this user); an empty one forgets it. */
export async function setToken(token: unknown) {
  const t = typeof token === 'string' ? token.trim() : ''
  if (!t) {
    await fsp.rm(tokenPath(), { force: true })
    return
  }
  if (/[\s\u0000-\u001f]/.test(t) || t.length > 400) throw new Error('That doesn’t look like a GitHub token.')
  await fsp.mkdir(path.dirname(tokenPath()), { recursive: true })
  await fsp.writeFile(tokenPath(), t, { mode: 0o600 })
}

/**
 * Why updates can't install here, if they can't:
 * - "translocated": macOS runs an app downloaded from the internet, and not notarized, from a
 *   temporary read-only copy until the download mark is taken off; an update can't replace it.
 * - "development": not a packaged build (npm run dev), so there's nothing to replace.
 * - "not-appimage": a Linux build that isn't the AppImage.
 */
export function blocker(): string | null {
  if (!app.isPackaged) return 'development'
  if (process.platform === 'darwin' && process.execPath.includes('/AppTranslocation/')) return 'translocated'
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'not-appimage'
  return null
}

interface GitHubResponse {
  status: number
  headers: Record<string, string | string[]>
  body: Readable
}

const readAll = async (body: Readable) => {
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** One request through Chromium's network stack (system proxy settings apply), not following redirects. */
function request(url: string, headers: Record<string, string>): Promise<GitHubResponse | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual', headers })
    req.on('redirect', (_status, _method, redirectUrl) => {
      req.abort()
      resolve({ redirect: redirectUrl })
    })
    req.on('response', (res) => resolve({ status: res.statusCode, headers: res.headers, body: res as unknown as Readable }))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Fetches from GitHub, following redirects by hand: release downloads redirect to a storage host,
 * which must not be sent the token.
 */
async function github(url: string, token: string, accept: string): Promise<GitHubResponse> {
  const origin = new URL(api()).origin
  for (let hops = 0; hops < 5; hops++) {
    const res = await request(url, {
      Accept: accept,
      'User-Agent': 'Player',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(new URL(url).origin === origin ? { Authorization: `Bearer ${token}` } : {}),
    })
    if ('redirect' in res) {
      url = new URL(res.redirect, url).toString()
      continue
    }
    return res
  }
  throw new Error('GitHub redirected too many times.')
}

async function latestRelease(token: string): Promise<{ tag: string; assets: Asset[] }> {
  let res: GitHubResponse
  try {
    res = await github(`${api()}/repos/${REPOSITORY}/releases/latest`, token, 'application/vnd.github+json')
  } catch (e) {
    throw new Error(`Couldn’t reach GitHub: ${(e as Error).message}`)
  }
  if (res.status === 401) {
    throw new Error('GitHub didn’t accept the token. It may have expired: make a new one and paste it in.')
  }
  if (res.status === 403 || res.status === 404) {
    throw new Error(
      `No release found. Either none has been published yet, or the token can’t read ${REPOSITORY} (it needs Contents: Read-only on that repository).`,
    )
  }
  if (res.status !== 200) throw new Error(`GitHub answered with an error (${res.status}). Try again later.`)
  const body = JSON.parse(await readAll(res.body)) as { tag_name: string; assets: Asset[] }
  return { tag: body.tag_name, assets: body.assets ?? [] }
}

/** The update found by the last check, ready to install. */
let pending: { found: Found; entry: PlatformEntry; asset: Asset; route: 'interface' | 'app' } | null = null

/** Looks for a newer version. Returns it, or null when Player is up to date. */
export async function check(): Promise<Found | null> {
  const token = readToken()
  if (!token) throw new Error('Add a GitHub token first.')
  const release = await latestRelease(token)
  const manifestAsset = release.assets.find((a) => a.name === 'latest.json')
  if (!manifestAsset) {
    throw new Error(`${release.tag} has no update files yet. It may still be building: try again in a few minutes.`)
  }
  const res = await github(manifestAsset.url, token, 'application/octet-stream')
  if (res.status !== 200) throw new Error(`Couldn’t read the update details (${res.status}).`)
  let manifest: Manifest
  try {
    manifest = JSON.parse(await readAll(res.body))
  } catch {
    throw new Error('The update details couldn’t be read.')
  }
  const current = app.getVersion()
  pending = null
  if (!manifest?.version || !newer(manifest.version, current)) return null
  // The update package when it fits this copy (an AppImage is replaced whole), else the whole app.
  const full = manifest.platforms?.[process.platform]
  const pkg = manifest.interface
  const route: 'interface' | 'app' | null =
    pkg?.file && pkg.sha512 && pkg.signature && packages.blocker() === null && shellFits(pkg.electron)
      ? 'interface'
      : full?.file && full.sha512 && full.signature
        ? 'app'
        : null
  if (!route) {
    throw new Error(
      pkg && !shellFits(pkg.electron)
        ? `Player ${manifest.version} needs a newer Player app than this one: download the whole app once from ${REPOSITORY}'s releases.`
        : `Player ${manifest.version} has no download for this computer.`,
    )
  }
  const entry = (route === 'interface' ? pkg : full)!
  const asset = release.assets.find((a) => a.name === entry.file)
  if (!asset) throw new Error(`${release.tag} is missing ${entry.file}.`)
  const found: Found = {
    version: manifest.version,
    current,
    notes: manifest.notes?.trim() || null,
    date: manifest.date ? manifest.date.slice(0, 10) : null,
  }
  pending = { found, entry, asset, route }
  return found
}

/** Downloads to the updates folder, hashing as it goes. */
async function download(asset: Asset, token: string, file: string, onProgress: (received: number, total: number | null) => void) {
  const res = await github(asset.url, token, 'application/octet-stream')
  if (res.status !== 200) throw new Error(`Couldn’t download the update (${res.status}).`)
  const total = Number(res.headers['content-length']) || null
  const hash = createHash('sha512')
  let received = 0
  let lastReport = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      received += chunk.length
      const now = Date.now()
      if (now - lastReport > 100) {
        lastReport = now
        onProgress(received, total)
      }
      done(null, chunk)
    },
  })
  await pipeline(res.body, meter, fs.createWriteStream(file))
  onProgress(received, total)
  return hash.digest('hex')
}

/**
 * Downloads the update found by the last check, checks its hash and signature, installs it and
 * restarts Player. `beforeRestart` runs just before quitting (to skip the "still playing?" guard).
 */
export async function install(win: BrowserWindow | null, beforeRestart: () => void) {
  if (!pending) throw new Error('Check for updates first.')
  const why = pending.route === 'interface' ? packages.blocker() : blocker()
  if (why === 'translocated') {
    throw new Error('macOS is running Player from a temporary read-only copy, so it can’t be updated. Follow the steps above, then try again.')
  }
  if (why === 'development') throw new Error('Updates install only in the packaged app.')
  if (why === 'not-appimage') throw new Error('Updates install only into the AppImage build on Linux.')
  const token = readToken()
  if (!token) throw new Error('Add a GitHub token first.')
  const { found, entry, asset, route } = pending

  const dir = path.join(app.getPath('userData'), 'updates')
  await ofs.promises.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, path.basename(entry.file))
  const sha512 = await download(asset, token, file, (received, total) =>
    win?.webContents.send('updates:progress', { received, total }),
  )

  const signature = Buffer.from(entry.signature, 'base64')
  const signedOk = verify(null, Buffer.from(signedMessage(found.version, route === 'interface' ? 'interface' : process.platform, entry.file, entry.sha512)), PUBLIC_KEY, signature)
  if (sha512 !== entry.sha512.toLowerCase() || !signedOk) {
    await ofs.promises.rm(dir, { recursive: true, force: true })
    throw new Error('The download doesn’t match its signature, so it wasn’t installed. Try again later.')
  }

  // The swap keeps this version for Go Back (Settings ▸ Update); an AppImage is replaced in place.
  if (route === 'interface') await packages.installDownloaded(file, found.version, 'interface')
  else if (process.platform === 'linux') await installAppImage(file)
  else await packages.installDownloaded(file, found.version, 'app')

  pending = null
  beforeRestart()
  app.quit()
}

/** Linux: replace the AppImage file itself (allowed while it runs), then start the new one. */
async function installAppImage(downloaded: string) {
  const target = process.env.APPIMAGE!
  const staged = `${target}.update`
  await fsp.copyFile(downloaded, staged)
  await fsp.chmod(staged, 0o755)
  await fsp.rename(staged, target)
  // Same arguments as this run, passed through "$@" so nothing is re-split by the shell.
  const script = `while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done; exec "$TARGET" "$@"`
  spawn('/bin/sh', ['-c', script, 'player-update', ...process.argv.slice(1)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PID: String(process.pid), TARGET: target },
  }).unref()
}
