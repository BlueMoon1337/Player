// Makes an update package: a zip that Settings ▸ Update… ▸ Install from Zip… installs, and that the
// Update button installs when a release carries it (npm run publish-package). It holds Player's
// interface, app.asar: everything but Electron itself (the page, the audio engine, the main and
// preload scripts), so one package fits every platform, and making it needs no build machine:
// GitHub Actions minutes aren't used. Only a new Electron needs the whole app (the Release workflow).
//
//   npm run update-package            → release/Player-<version>-update.zip
//
// With UPDATE_SIGNING_KEY set (the release key, the Ed25519 private key PEM, as for
// scripts/release.mjs) the package is signed, and Player says so; without it, Player warns
// that it isn't, and the Update button won't take it.

import { createPackage, getRawHeader } from '@electron/asar'
import { execSync } from 'node:child_process'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const version = pkg.version
const electron = JSON.parse(fs.readFileSync('node_modules/electron/package.json', 'utf8')).version
const OUT_DIR = 'release'
const name = `Player-${version}-update`

/** Must match signedMessage() in electron/packages.ts (the platform is "interface"). */
const signedMessage = (file, sha512) => `Player update\n${version}\ninterface\n${file}\n${sha512}`
const key = process.env.UPDATE_SIGNING_KEY ? createPrivateKey(process.env.UPDATE_SIGNING_KEY) : null

if (!process.argv.includes('--no-build')) execSync('npm run build', { stdio: 'inherit' })

// What electron-builder.yml packs into app.asar: dist/, dist-electron/ (no source maps), package.json.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'player-asar-'))
fs.cpSync('dist', path.join(stage, 'dist'), { recursive: true })
fs.mkdirSync(path.join(stage, 'dist-electron'))
for (const f of fs.readdirSync('dist-electron')) {
  if (!f.endsWith('.map')) fs.copyFileSync(path.join('dist-electron', f), path.join(stage, 'dist-electron', f))
}
const keep = ['name', 'productName', 'version', 'description', 'author', 'main', 'type', 'desktopName']
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(Object.fromEntries(keep.filter((k) => pkg[k] !== undefined).map((k) => [k, pkg[k]])), null, 2),
)

fs.mkdirSync(OUT_DIR, { recursive: true })
const asar = path.join(OUT_DIR, `${name}.asar`)
await createPackage(stage, asar)
fs.rmSync(stage, { recursive: true, force: true })

const data = fs.readFileSync(asar)
const sha512 = createHash('sha512').update(data).digest('hex')
const manifest = {
  format: 1,
  kind: 'interface',
  version,
  electron,
  file: 'app.asar',
  sha512,
  date: new Date().toISOString(),
  notes: process.env.UPDATE_NOTES || undefined,
}
if (key) manifest.signature = sign(null, Buffer.from(signedMessage('app.asar', sha512)), key).toString('base64')

const readme = `Player ${version} update package
==========================

Your songs, setlists and settings aren't touched. The version you have now is kept, so you can go back to it.
${manifest.signature ? '' : 'This package isn’t signed with Player’s release key.\n'}
Player 1.4.0 or later
---------------------
1. In Player, open Settings ▸ About ▸ Update… (or Player ▸ Check for Updates…).
2. Under From a Zip, click Install from Zip… and choose this zip (no need to unzip it).
3. Click Install and Restart.
To go back: the same window ▸ Previous Version ▸ Go Back.

Player 1.3.0 or earlier, on a Mac (no Install from Zip yet)
-----------------------------------------------------------
1. Unzip this file in your Downloads folder (double-click it).
2. Open Terminal (Applications ▸ Utilities ▸ Terminal).
3. Paste this line and press Return:

     bash ~/Downloads/${name}/install-on-mac.sh

   If macOS asks whether Terminal may access Downloads or change apps, click Allow.
4. The script quits Player, keeps the version you have for Go Back, puts ${version} in,
   signs the app again (as the release build does) and opens it.
To go back afterwards: Settings ▸ About ▸ Update… ▸ Go Back, or run the command the script prints at the end.

Windows
-------
Player 1.4.0 or later: Install from Zip…, as above. For Player 1.3.0 on Windows, install
the whole app once (Player-Setup-<version>.exe) from a release; after that, packages work.
`
// The fingerprint Electron may check app.asar against (Info.plist's ElectronAsarIntegrity).
const headerHash = createHash('sha256').update(getRawHeader(asar).headerString).digest('hex')
const macScript = fs.readFileSync('scripts/install-on-mac.sh', 'utf8').replaceAll('@VERSION@', version).replaceAll('@HASH@', headerHash)

const zipFile = path.join(OUT_DIR, `${name}.zip`)
fs.writeFileSync(
  zipFile,
  zip([
    [`${name}/app.asar`, data],
    [`${name}/player-update.json`, Buffer.from(JSON.stringify(manifest, null, 2))],
    [`${name}/README.txt`, Buffer.from(readme)],
    [`${name}/install-on-mac.sh`, Buffer.from(macScript), 0o755],
  ]),
)
fs.rmSync(asar)

// What the Update button reads from a release's latest.json (npm run publish-package adds it).
const zipSha = createHash('sha512').update(fs.readFileSync(zipFile)).digest('hex')
const entry = { file: path.basename(zipFile), sha512: zipSha, electron }
if (key) entry.signature = sign(null, Buffer.from(signedMessage(entry.file, zipSha)), key).toString('base64')
fs.writeFileSync(path.join(OUT_DIR, 'update-interface.json'), JSON.stringify(entry, null, 2))

console.log(`${zipFile} (${(fs.statSync(zipFile).size / 1e6).toFixed(1)} MB, ${manifest.signature ? 'signed' : 'not signed'})`)

/** A plain zip (deflated entries), enough for ditto, tar.exe and unzip. */
function zip(files) {
  const local = []
  const central = []
  let offset = 0
  // 1980-01-01 00:00 in DOS time: the same package bytes every time for the same contents.
  const time = 0
  const date = (0 << 9) | (1 << 5) | 1
  for (const [file, content, mode = 0o644] of files) {
    const nameBuf = Buffer.from(file, 'utf8')
    const deflated = zlib.deflateRawSync(content, { level: 9 })
    const crc = zlib.crc32(content)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4) // version needed
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(8, 8) // deflate
    head.writeUInt16LE(time, 10)
    head.writeUInt16LE(date, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(deflated.length, 18)
    head.writeUInt32LE(content.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, nameBuf, deflated)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(0x031e, 4) // made by: Unix, zip 3.0
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(deflated.length, 20)
    dir.writeUInt32LE(content.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38) // a regular file and its permissions
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)
    offset += head.length + nameBuf.length + deflated.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuf, end])
}
