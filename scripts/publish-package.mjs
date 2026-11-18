// Publishes an update package where the Update button finds it, with no build machine: no
// GitHub Actions minutes.
//
//   npm run update-package       (with UPDATE_SIGNING_KEY set: the Update button only takes signed packages)
//   npm run publish-package      → commits it to the "updates" branch and pushes it
//
// The updates branch holds latest.json and Player-<version>-update.zip (older zips stay in its
// history). Player reads them from GitHub's public file address, so no token is needed while the
// repository is public. Pushing needs only the git access you push main with.
//
//   npm run publish-package -- --release   → a GitHub release v<version> instead, through the API
//                                            (GITHUB_TOKEN with Contents: Read and write)
//
// UPDATE_COMMIT_TRAILERS, if set, is added to the end of the branch commit's message.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = process.env.GITHUB_REPOSITORY || 'BlueMoon1337/Player'
const BRANCH = 'updates'
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const tag = `v${version}`
const force = process.argv.includes('--force')

const entry = JSON.parse(fs.readFileSync('release/update-interface.json', 'utf8'))
if (!entry.signature) throw new Error('The package isn’t signed: run npm run update-package with UPDATE_SIGNING_KEY set.')
if (!entry.file.includes(`-${version}-`)) throw new Error(`release/update-interface.json is for ${entry.file}, not ${version}: run npm run update-package again.`)
const zip = path.join('release', entry.file)

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim()

/** 1.2.10 > 1.2.9 (as electron/packages.ts compares). */
function newer(a, b) {
  const parse = (v) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// The changes since the last published version, as its notes.
function changes(since) {
  if (process.env.UPDATE_NOTES) return process.env.UPDATE_NOTES
  try {
    // From the previous version's "Version x.y.z" commit (else the one before this version's).
    const from = since
      ? git(['log', '-1', '--format=%H', '--grep', `^Version ${since.replace(/\./g, '\\.')}$`, 'HEAD'])
      : (git(['log', '--format=%H %s', '--grep', '^Version [0-9]', 'HEAD'])
          .split('\n')
          .find((l) => l && !l.endsWith(` ${version}`))
          ?.split(' ')[0] ?? '')
    return git(['log', '--no-merges', '--pretty=- %s', from ? `${from}..HEAD` : '-20', '--', '.', ':!package.json', ':!package-lock.json'])
  } catch {
    return ''
  }
}

async function toBranch() {
  const remote = git(['remote', 'get-url', 'origin'])
  const author = git(['log', '-1', '--format=%an <%ae>'])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-updates-'))
  const g = (args) => git(['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    g(['init', '-q'])
    g(['remote', 'add', 'origin', remote])
    let previous = null
    try {
      g(['fetch', '-q', '--depth', '1', 'origin', BRANCH])
      g(['checkout', '-q', '-B', BRANCH, 'FETCH_HEAD'])
      previous = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')).version
    } catch {
      g(['checkout', '-q', '--orphan', BRANCH])
    }
    if (previous && !newer(version, previous) && !force) {
      throw new Error(`The updates branch already has ${previous}; raise the version (or pass --force).`)
    }
    for (const f of fs.readdirSync(dir)) if (/-update\.zip$/.test(f)) fs.rmSync(path.join(dir, f))
    fs.copyFileSync(zip, path.join(dir, entry.file))
    const manifest = { version, notes: changes(previous), date: new Date().toISOString(), interface: entry }
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      `# Player updates\n\nWhat Player's Update button installs: \`latest.json\` names the newest version and its signed update package.\n` +
        `Made by \`npm run update-package\` and \`npm run publish-package\` on main; don't edit by hand.\n\n` +
        `To install by hand, download [${entry.file}](${entry.file}?raw=1) and use Settings ▸ About ▸ Update… ▸ Install from Zip… in Player.\n`,
    )
    g(['add', '-A'])
    const trailers = process.env.UPDATE_COMMIT_TRAILERS ? `\n\n${process.env.UPDATE_COMMIT_TRAILERS}` : ''
    git(['-C', dir, '-c', `user.name=${author.replace(/ <.*/, '')}`, '-c', `user.email=${author.replace(/.*<|>$/g, '')}`, 'commit', '-q', `--author=${author}`, '-m', `Player ${version}${trailers}`])
    for (let attempt = 1; ; attempt++) {
      try {
        g(['push', '-q', 'origin', `${BRANCH}:${BRANCH}`])
        break
      } catch (e) {
        if (attempt === 4) throw e
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
      }
    }
    console.log(`Published ${version} to the ${BRANCH} branch: https://github.com/${REPO}/tree/${BRANCH}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function toRelease() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) throw new Error('Set GITHUB_TOKEN (Contents: Read and write on the repository).')
  const gh = async (method, url, body, headers = {}) => {
    const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${REPO}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body,
    })
    if (res.status === 404 && method === 'GET') return null
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${await res.text()}`)
    return res.status === 204 ? null : res.json()
  }
  const upload = async (release, name, data, contentType) => {
    for (const a of release.assets.filter((x) => x.name === name)) await gh('DELETE', `/releases/assets/${a.id}`)
    await gh('POST', `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, data, {
      'Content-Type': contentType,
    })
    console.log(`Uploaded ${name}`)
  }
  let release = await gh('GET', `/releases/tags/${tag}`)
  if (!release) {
    release = await gh('POST', '/releases', JSON.stringify({ tag_name: tag, target_commitish: git(['rev-parse', 'HEAD']), name: `Player ${tag}`, body: changes(null), draft: true }))
  }
  release.assets ??= []
  // Keep whole-app entries a workflow run put in latest.json.
  let platforms = {}
  const old = release.assets.find((a) => a.name === 'latest.json')
  if (old) {
    const res = await fetch(old.url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' } })
    if (res.ok) platforms = (await res.json()).platforms ?? {}
  }
  await upload(release, entry.file, fs.readFileSync(zip), 'application/zip')
  const manifest = { version, notes: release.body ?? '', date: new Date().toISOString(), platforms, interface: entry }
  await upload(release, 'latest.json', JSON.stringify(manifest, null, 2), 'application/json')
  if (release.draft) await gh('PATCH', `/releases/${release.id}`, JSON.stringify({ draft: false, make_latest: 'true' }))
  console.log(`Published ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
}

await (process.argv.includes('--release') ? toRelease() : toBranch())
