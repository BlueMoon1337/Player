// Updates from zip packages, and going back to the version before.
//
// A package is a zip with one of:
// - an interface update: app.asar (all of Player but Electron itself: the page, the audio engine,
//   the main and preload scripts), with player-update.json saying its version, its SHA-512, the
//   Electron it was built for and, when the release key signed it, a signature. npm run
//   update-package makes one; it fits every platform. Settings ▸ Update ▸ Install from Zip…
//   installs it, and so does the Update button when a release carries one.
// - a whole app: Player.app (the zip a Mac release carries), or on Windows the installer.
//
// Before anything is replaced, the version being replaced is kept in <settings>/versions/previous,
// so Go Back can put it back (and Go Back again swaps them once more). The library and settings
// live outside the app and are never touched. The swap itself happens in a small script that
// waits for Player to quit, does it, records how it went and opens Player again.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// Electron's fs treats .asar files as folders; this one sees them as the files they are.
import ofs from 'original-fs'
import type { PackageInfo, PreviousVersion, UpdateResult } from '../src/platform/types'
import publicKeyPem from './update-key.pem'

const PUBLIC_KEY = createPublicKey(publicKeyPem)
const APP_ID = 'com.bluemoon1337.player'
export const MANIFEST = 'player-update.json'

/** What's signed for each file (scripts/release.mjs and scripts/update-package.mjs build the same text). */
export function signedMessage(version: string, platform: string, file: string, sha512: string) {
  return `Player update\n${version}\n${platform}\n${file}\n${sha512}`
}

/** 1.2.10 > 1.2.9; anything after a "-" (pre-release) is ignored. */
export function newer(a: string, b: string) {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/**
 * Whether an interface built for Electron `built` runs in this copy's Electron. The same major
 * version is enough (the interface uses nothing that changes within one); a different one needs
 * the whole app.
 */
export function shellFits(built: string | undefined): boolean {
  if (!built) return true
  return built.split('.')[0] === process.versions.electron.split('.')[0]
}

const shellMessage = (built: string) =>
  `That package needs a newer Player app (it’s built for Electron ${built.split('.')[0]}, and this copy has ${
    process.versions.electron.split('.')[0]
  }). Install the whole app once: the Mac zip or disk image, or the Windows installer.`

// ------------------------------------------------------------------ places

const versionsDir = () => path.join(app.getPath('userData'), 'versions')
const previousDir = () => path.join(versionsDir(), 'previous')
const previousMeta = () => path.join(versionsDir(), 'previous.json')
const resultFile = () => path.join(versionsDir(), 'result.json')
const stagingRoot = () => path.join(app.getPath('userData'), 'updates', 'packages')

/** The running app's interface file. */
const asarPath = () => path.join(process.resourcesPath, 'app.asar')
/** macOS: …/Player.app/Contents/MacOS/Player → …/Player.app */
const macBundle = () => path.resolve(process.execPath, '..', '..', '..')
/** Windows and Linux: the folder Player is installed in. */
const installDir = () => path.dirname(process.execPath)

/** What the payload kept for Go Back is called inside versions/previous. */
const PAYLOAD: Record<PreviousVersion['kind'], string> = { interface: 'app.asar', bundle: 'Player.app', dir: 'app' }

// ------------------------------------------------------------------ helpers

function run(cmd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.trim().slice(0, 300)}`))))
  })
}

export async function unzip(zip: string, dest: string) {
  await ofs.promises.mkdir(dest, { recursive: true })
  if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-x', '-k', zip, dest])
  else if (process.platform === 'win32') await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest])
  else await run('unzip', ['-q', '-o', zip, '-d', dest])
}

/** The SHA-512 of a file, read as bytes (an .asar too). */
function sha512(file: string) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha512')
    ofs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/** The fingerprint Electron can check an .asar against (the SHA-256 of its header), as Info.plist records it. */
export function asarHeaderHash(file: string) {
  const fd = ofs.openSync(file, 'r')
  try {
    const size = Buffer.alloc(8)
    ofs.readSync(fd, size, 0, 8, 0)
    const headerSize = size.readUInt32LE(4)
    const header = Buffer.alloc(headerSize)
    ofs.readSync(fd, header, 0, headerSize, 8)
    const length = header.readUInt32LE(4)
    return createHash('sha256').update(header.subarray(8, 8 + length).toString('utf8')).digest('hex')
  } finally {
    ofs.closeSync(fd)
  }
}

/** Files and folders at the top of the package, or in its one top folder. */
function entries(dir: string): string[] {
  const top = ofs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== '__MACOSX')
  const out = top.map((n) => path.join(dir, n))
  if (top.length === 1 && ofs.statSync(out[0]).isDirectory() && !out[0].endsWith('.app')) {
    return ofs.readdirSync(out[0]).filter((n) => !n.startsWith('.')).map((n) => path.join(out[0], n))
  }
  return out
}

/** The processor a macOS program is built for: 'arm64', 'x64', 'universal', or null if it can't tell. */
function machArch(file: string): string | null {
  try {
    const fd = ofs.openSync(file, 'r')
    const b = Buffer.alloc(8)
    ofs.readSync(fd, b, 0, 8, 0)
    ofs.closeSync(fd)
    if (b.readUInt32BE(0) === 0xcafebabe) return 'universal'
    if (b.readUInt32LE(0) !== 0xfeedfacf) return null
    const cpu = b.readUInt32LE(4)
    return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : null
  } catch {
    return null
  }
}

const plist = (file: string, key: string) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file]).then((s) => s.trim())

function compare(version: string, current: string): PackageInfo['compared'] {
  return newer(version, current) ? 'newer' : newer(current, version) ? 'older' : 'same'
}

// ------------------------------------------------------------------ reading a package

/** What the last package looked at is, and where it was unpacked: what Install installs. */
let pending: (PackageInfo & { payload: string; staged: string; headerHash: string | null }) | null = null

/**
 * Why packages can't be installed here, if they can't:
 * - "development": not a packaged build (npm run dev).
 * - "translocated": macOS is running Player from a temporary read-only copy (see updates.ts).
 * - "appimage": the AppImage is read-only inside; it's updated as a whole by the Update button.
 */
export function blocker(): string | null {
  if (!app.isPackaged) return 'development'
  if (process.platform === 'darwin' && process.execPath.includes('/AppTranslocation/')) return 'translocated'
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage'
  return null
}

/** Unpacks a zip and works out what it is, without installing anything. */
export async function inspect(zip: string): Promise<PackageInfo> {
  if (!/\.zip$/i.test(zip)) throw new Error('Choose a .zip update package.')
  await ofs.promises.rm(stagingRoot(), { recursive: true, force: true })
  // A fresh folder each time: Electron remembers .asar files it has read by their path.
  const staged = path.join(stagingRoot(), String(Date.now()))
  try {
    await unzip(zip, staged)
  } catch {
    throw new Error('That file isn’t a zip Player can open: it may be damaged or not fully downloaded.')
  }
  const found = entries(staged)
  const byName = (re: RegExp) => found.find((f) => re.test(path.basename(f)))
  const current = app.getVersion()
  const file = path.basename(zip)

  let manifest: { kind?: string; version?: string; sha512?: string; signature?: string; notes?: string; electron?: string } | null = null
  const manifestFile = byName(/^player-update\.json$/i)
  if (manifestFile) {
    try {
      manifest = JSON.parse(ofs.readFileSync(manifestFile, 'utf8'))
    } catch {
      throw new Error(`The package’s ${MANIFEST} can’t be read.`)
    }
  }

  const asar = byName(/^app\.asar$/i)
  const bundle = byName(/\.app$/i)
  const installer = byName(/^Player-Setup-.*\.exe$/i)

  if (asar) {
    // Read through Electron's own .asar support: it has to be Player's interface.
    let pkg: { name?: string; version?: string; main?: string }
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'))
    } catch {
      throw new Error('That app.asar isn’t a Player interface.')
    }
    if (pkg.name !== 'player' || !pkg.version || !pkg.main || !fs.existsSync(path.join(asar, pkg.main))) {
      throw new Error('That app.asar isn’t a Player interface.')
    }
    if (manifest?.version && manifest.version !== pkg.version) {
      throw new Error(`The package says ${manifest.version} but contains ${pkg.version}, so it wasn’t installed.`)
    }
    if (!shellFits(manifest?.electron)) throw new Error(shellMessage(manifest!.electron!))
    const digest = await sha512(asar)
    // The checksum, when given, must match (a damaged download doesn't); the signature, when
    // given, must be the release key's over that checksum.
    if (manifest?.sha512 && manifest.sha512.toLowerCase() !== digest) {
      throw new Error('The package is damaged: its interface doesn’t match its checksum. Download it again.')
    }
    let signed = false
    if (manifest?.signature) {
      const message = Buffer.from(signedMessage(pkg.version, 'interface', 'app.asar', digest))
      if (!verify(null, message, PUBLIC_KEY, Buffer.from(manifest.signature, 'base64'))) {
        throw new Error('The package doesn’t match its signature, so it wasn’t installed.')
      }
      signed = true
    }
    pending = {
      kind: 'interface',
      version: pkg.version,
      current,
      signed,
      compared: compare(pkg.version, current),
      notes: manifest?.notes?.trim() || null,
      file,
      payload: asar,
      staged,
      headerHash: asarHeaderHash(asar),
    }
  } else if (bundle) {
    if (process.platform !== 'darwin') throw new Error('That package is Player for Mac; this computer needs the Windows installer.')
    const info = path.join(bundle, 'Contents', 'Info.plist')
    const id = await plist(info, 'CFBundleIdentifier').catch(() => '')
    if (id !== APP_ID) throw new Error('That package doesn’t contain Player.')
    const version = await plist(info, 'CFBundleShortVersionString')
    const arch = machArch(path.join(bundle, 'Contents', 'MacOS', 'Player'))
    if (arch && arch !== 'universal' && arch !== process.arch) {
      const chip = (a: string) => (a === 'arm64' ? 'Apple silicon' : 'Intel')
      throw new Error(`That package is Player for ${chip(arch)} Macs; this Mac is ${chip(process.arch)}.`)
    }
    pending = { kind: 'app', version, current, signed: false, compared: compare(version, current), notes: null, file, payload: bundle, staged, headerHash: null }
  } else if (installer) {
    if (process.platform !== 'win32') throw new Error('That package is the Windows installer; this computer needs Player for Mac.')
    const version = /(\d+\.\d+\.\d+)/.exec(path.basename(installer))?.[1]
    if (!version) throw new Error('Can’t tell which version that installer is.')
    pending = { kind: 'installer', version, current, signed: false, compared: compare(version, current), notes: null, file, payload: installer, staged, headerHash: null }
  } else {
    throw new Error('That zip isn’t a Player update package: it has no app.asar, Player.app or installer in it.')
  }
  const { payload: _p, staged: _s, headerHash: _h, ...info } = pending
  return info
}

/** Forgets the package looked at (Cancel). */
export async function discard() {
  pending = null
  await ofs.promises.rm(stagingRoot(), { recursive: true, force: true })
}

// ------------------------------------------------------------------ the version before

export async function previous(): Promise<PreviousVersion | null> {
  try {
    const meta = JSON.parse(await ofs.promises.readFile(previousMeta(), 'utf8')) as PreviousVersion
    if (!meta?.version || !PAYLOAD[meta.kind]) return null
    await ofs.promises.access(path.join(previousDir(), PAYLOAD[meta.kind]))
    return meta
  } catch {
    return null
  }
}

/** How the last update or Go Back went (once, after the restart). */
export async function takeResult(): Promise<UpdateResult | null> {
  try {
    const r = JSON.parse(await ofs.promises.readFile(resultFile(), 'utf8')) as UpdateResult
    await ofs.promises.rm(resultFile(), { force: true })
    return r
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ swapping

interface Swap {
  action: 'update' | 'revert'
  /** interface: replace app.asar; bundle: replace Player.app; dir: replace the install folder; installer: run it. */
  kind: 'interface' | 'bundle' | 'dir' | 'installer'
  /** What goes in. */
  source: string
  version: string
  headerHash?: string | null
}

async function writable(dir: string) {
  try {
    await ofs.promises.access(dir, fs.constants.W_OK)
  } catch {
    throw new Error(
      `Player can’t write to ${dir}. ${process.platform === 'darwin' ? 'Move Player to your Applications folder' : 'Install Player for your user only'}, then try again.`,
    )
  }
}

/**
 * Hands the swap to a script that waits for Player to quit, keeps what's there as the previous
 * version, puts the new one in, records the result and opens Player again.
 */
async function startSwap(swap: Swap) {
  const why = blocker()
  if (why === 'translocated') {
    throw new Error('macOS is running Player from a temporary read-only copy, so it can’t be updated. Follow the steps above, then try again.')
  }
  if (why === 'development') throw new Error('Updates install only in the packaged app.')
  if (why === 'appimage') throw new Error('The AppImage can’t take update packages: the Update button replaces it as a whole.')
  await ofs.promises.mkdir(versionsDir(), { recursive: true })
  await ofs.promises.rm(resultFile(), { force: true })

  const mac = process.platform === 'darwin'
  const target = swap.kind === 'interface' ? asarPath() : swap.kind === 'bundle' ? macBundle() : installDir()
  await writable(path.dirname(target))
  if (swap.kind === 'interface') await writable(target)
  // What's kept for Go Back: the same kind of thing as what's replaced (an installer replaces the whole folder).
  const keptKind: PreviousVersion['kind'] = swap.kind === 'installer' ? 'dir' : swap.kind
  const kept: PreviousVersion = { version: app.getVersion(), kind: keptKind, savedAt: Date.now() }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PL_PID: String(process.pid),
    PL_KIND: swap.kind,
    PL_ACTION: swap.action,
    PL_TARGET: target,
    PL_SOURCE: swap.source,
    PL_PREV: previousDir(),
    PL_PREV_PAYLOAD: PAYLOAD[keptKind],
    PL_META: JSON.stringify(kept),
    PL_META_FILE: previousMeta(),
    PL_RESULT: resultFile(),
    PL_VERSION: swap.version,
    PL_HASH: swap.headerHash ?? '',
    PL_BUNDLE: mac ? macBundle() : '',
    PL_EXE: process.execPath,
  }
  if (process.platform === 'win32') {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', WINDOWS_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    }).unref()
  } else {
    spawn('/bin/sh', ['-c', POSIX_SCRIPT], { detached: true, stdio: 'ignore', env }).unref()
  }
}

/** Installs the package looked at last; Player quits and the script opens the new version. */
export async function install(beforeRestart: () => void) {
  if (!pending) throw new Error('Choose a package first.')
  const p = pending
  const kind = p.kind === 'interface' ? 'interface' : p.kind === 'app' ? 'bundle' : 'installer'
  await startSwap({ action: 'update', kind, source: p.payload, version: p.version, headerHash: p.headerHash })
  pending = null
  beforeRestart()
  app.quit()
}

/** Puts the previous version back (and keeps this one as the previous, to come back to). */
export async function revert(beforeRestart: () => void) {
  const prev = await previous()
  if (!prev) throw new Error('There’s no previous version kept.')
  const source = path.join(previousDir(), PAYLOAD[prev.kind])
  const headerHash = prev.kind === 'interface' ? asarHeaderHash(source) : null
  await startSwap({ action: 'revert', kind: prev.kind, source, version: prev.version, headerHash })
  beforeRestart()
  app.quit()
}

/**
 * For the Update button: installs a download the same way, keeping this version for Go Back.
 * `zip` is an interface package (checked as Install from Zip checks one) or, with `kind`, a
 * whole app already checked against latest.json.
 */
export async function installDownloaded(file: string, version: string, kind: 'interface' | 'app') {
  if (kind === 'interface') {
    const info = await inspect(file)
    if (!info.signed || info.version !== version) throw new Error('The download doesn’t match its signature, so it wasn’t installed.')
    const p = pending!
    await startSwap({ action: 'update', kind: 'interface', source: p.payload, version: p.version, headerHash: p.headerHash })
    pending = null
    return
  }
  if (process.platform === 'darwin') {
    const unpacked = path.join(path.dirname(file), 'unpacked')
    await unzip(file, unpacked)
    const bundle = ofs.readdirSync(unpacked).find((n) => n.endsWith('.app'))
    if (!bundle) throw new Error('The update didn’t contain Player.app.')
    await startSwap({ action: 'update', kind: 'bundle', source: path.join(unpacked, bundle), version })
  } else {
    await startSwap({ action: 'update', kind: 'installer', source: file, version })
  }
}

// ------------------------------------------------------------------ the scripts

// macOS and Linux. Copies or moves into place, never deletes what's there until the new one is in.
const POSIX_SCRIPT = String.raw`
while kill -0 "$PL_PID" 2>/dev/null; do sleep 0.2; done
sleep 0.5
TMP="$PL_PREV.tmp"
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
finish() {
  printf '{"ok":%s,"action":"%s","version":"%s","message":"%s"}' "$1" "$PL_ACTION" "$PL_VERSION" "$(json "$2")" > "$PL_RESULT"
  if [ -n "$PL_BUNDLE" ]; then open "$PL_BUNDLE"; else nohup "$PL_EXE" >/dev/null 2>&1 & fi
  exit 0
}
rm -rf "$TMP" && mkdir -p "$TMP" || finish false "Couldn't make room to keep the current version."
case "$PL_KIND" in
  interface)
    cp "$PL_TARGET" "$TMP/$PL_PREV_PAYLOAD" || finish false "Couldn't keep the current version, so nothing was changed."
    cp "$PL_SOURCE" "$PL_TARGET.new" || { rm -f "$PL_TARGET.new"; finish false "Couldn't copy the new version in, so nothing was changed."; }
    mv -f "$PL_TARGET.new" "$PL_TARGET" || { rm -f "$PL_TARGET.new"; finish false "Couldn't put the new version in place, so nothing was changed."; }
    if [ -n "$PL_BUNDLE" ]; then
      PL="$PL_BUNDLE/Contents/Info.plist"
      /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PL_VERSION" "$PL" 2>/dev/null
      /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $PL_VERSION" "$PL" 2>/dev/null
      if [ -n "$PL_HASH" ] && /usr/libexec/PlistBuddy -c "Print :ElectronAsarIntegrity:Resources/app.asar:hash" "$PL" >/dev/null 2>&1; then
        /usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $PL_HASH" "$PL"
      fi
      codesign --force --deep --sign - "$PL_BUNDLE" >/dev/null 2>&1
    fi
    ;;
  bundle)
    mv "$PL_TARGET" "$TMP/$PL_PREV_PAYLOAD" || finish false "Couldn't move the current version aside, so nothing was changed."
    if ! mv "$PL_SOURCE" "$PL_TARGET"; then
      mv "$TMP/$PL_PREV_PAYLOAD" "$PL_TARGET"
      finish false "Couldn't put the new version in place, so the current one was put back."
    fi
    xattr -dr com.apple.quarantine "$PL_TARGET" 2>/dev/null
    ;;
  *)
    finish false "This kind of update can't be installed on this computer."
    ;;
esac
rm -rf "$PL_PREV" && mv "$TMP" "$PL_PREV" && printf '%s' "$PL_META" > "$PL_META_FILE"
finish true ""
`

// Windows. interface: swap app.asar; dir: swap the install folder; installer: keep the folder, then run it.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id ([int]$env:PL_PID) -Timeout 60 } catch {}
Start-Sleep -Milliseconds 500
$tmp = "$($env:PL_PREV).tmp"
function Finish($ok, $msg) {
  $r = @{ ok = $ok; action = $env:PL_ACTION; version = $env:PL_VERSION; message = $msg } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($env:PL_RESULT, $r)
  if ($env:PL_KIND -ne 'installer' -or -not $ok) { Start-Process -FilePath $env:PL_EXE }
  exit 0
}
function Keep() {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $env:PL_PREV
  Move-Item $tmp $env:PL_PREV
  [IO.File]::WriteAllText($env:PL_META_FILE, $env:PL_META)
}
try {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
  New-Item -ItemType Directory -Force $tmp | Out-Null
} catch { Finish $false "Couldn't make room to keep the current version." }
switch ($env:PL_KIND) {
  'interface' {
    try { Copy-Item $env:PL_TARGET (Join-Path $tmp $env:PL_PREV_PAYLOAD) } catch { Finish $false "Couldn't keep the current version, so nothing was changed." }
    try { Copy-Item $env:PL_SOURCE "$($env:PL_TARGET).new"; Move-Item -Force "$($env:PL_TARGET).new" $env:PL_TARGET }
    catch { Remove-Item -Force -ErrorAction SilentlyContinue "$($env:PL_TARGET).new"; Finish $false "Couldn't put the new version in place, so nothing was changed." }
    Keep; Finish $true ''
  }
  'dir' {
    $keep = Join-Path $tmp $env:PL_PREV_PAYLOAD
    robocopy $env:PL_TARGET $keep /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Finish $false "Couldn't keep the current version, so nothing was changed." }
    robocopy $env:PL_SOURCE $env:PL_TARGET /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
      robocopy $keep $env:PL_TARGET /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
      Finish $false "Couldn't put the previous version in place, so the current one was put back."
    }
    Keep; Finish $true ''
  }
  'installer' {
    $keep = Join-Path $tmp $env:PL_PREV_PAYLOAD
    robocopy $env:PL_TARGET $keep /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    $kept = $LASTEXITCODE -lt 8
    $p = Start-Process -FilePath $env:PL_SOURCE -ArgumentList '/S','--updated','--force-run' -PassThru -Wait
    if ($p.ExitCode -ne 0) { Finish $false "The installer stopped (code $($p.ExitCode)); Player wasn't changed." }
    if ($kept) { Keep }
    Finish $true ''
  }
}
Finish $false "This kind of update can't be installed on this computer."
`
