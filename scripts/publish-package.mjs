// Publishes an update package as a GitHub release, with no build machine: no Actions minutes.
//
//   npm run update-package              (with UPDATE_SIGNING_KEY set: the Update button only takes signed packages)
//   GITHUB_TOKEN=… npm run publish-package
//
// The release (v<version>) carries Player-<version>-update.zip and latest.json, whose "interface"
// entry the Update button installs from. The token needs Contents: Read and write on the repository.
// If the version is already released with whole apps (the Release workflow), the package is
// added to it and latest.json keeps their entries.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO = process.env.GITHUB_REPOSITORY || 'BlueMoon1337/Player'
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const tag = `v${version}`
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token) throw new Error('Set GITHUB_TOKEN (Contents: Read and write on the repository).')

const entry = JSON.parse(fs.readFileSync('release/update-interface.json', 'utf8'))
if (!entry.signature) throw new Error('The package isn’t signed: run npm run update-package with UPDATE_SIGNING_KEY set.')
const zip = path.join('release', entry.file)
if (!entry.file.includes(`-${version}-`)) throw new Error(`release/update-interface.json is for ${entry.file}, not ${version}: run npm run update-package again.`)

async function gh(method, url, body, headers = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${REPO}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...headers },
    body,
  })
  if (res.status === 404 && method === 'GET') return null
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function upload(release, name, data, contentType) {
  for (const a of release.assets.filter((x) => x.name === name)) await gh('DELETE', `/releases/assets/${a.id}`)
  await gh('POST', `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, data, {
    'Content-Type': contentType,
  })
  console.log(`Uploaded ${name}`)
}

// The changes since the last release, as its notes.
let notes = process.env.UPDATE_NOTES || ''
if (!notes) {
  try {
    const previous = execSync(`git tag --list 'v*' --sort=-v:refname`, { encoding: 'utf8' })
      .split('\n')
      .find((t) => t && t !== tag)
    notes = execSync(`git log --no-merges --pretty='- %s' ${previous ? `${previous}..` : ''}HEAD`, { encoding: 'utf8' }).trim()
  } catch {
    notes = ''
  }
}

let release = await gh('GET', `/releases/tags/${tag}`)
if (!release) {
  const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  release = await gh('POST', '/releases', JSON.stringify({ tag_name: tag, target_commitish: sha, name: `Player ${tag}`, body: notes, draft: true }))
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
const manifest = { version, notes: release.body ?? notes, date: new Date().toISOString(), platforms, interface: entry }
await upload(release, 'latest.json', JSON.stringify(manifest, null, 2), 'application/json')
if (release.draft) await gh('PATCH', `/releases/${release.id}`, JSON.stringify({ draft: false, make_latest: 'true' }))
console.log(`Published ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
