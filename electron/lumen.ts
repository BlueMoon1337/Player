// The Random Countdown, Fade Out Music and Outro boxes' link to Lumen
// (github.com/BlueMoon1337/lumen), the presentation app, on this computer or another one on the
// local network.
//
// Lumen Remote is JSON over UDP port 57312 (Lumen's src-tauri/src/remote.rs). Player asks
// `{"app":"lumen-remote","v":1,"cmd":"hello"}` and each Lumen answers with its name and what it can
// do; `{"cmd":"play","what":"random-countdown"|"outro"|"fade-music","id":…}` does it (a fade with
// its "seconds"), and Lumen answers whether it did. Player only asks while the boxes are showing (Settings ▸ General ▸ Lumen Boxes): one
// question to the network every few seconds, so a box can say whether Lumen is there.

import dgram from 'node:dgram'
import os from 'node:os'
import type { LumenPlayResult, LumenState, LumenWhat } from '../src/platform/types'

const PORT = 57312
const APP = 'lumen-remote'
/** How often Lumen is asked who's there while the boxes show. */
const LOOK_MS = 4000
/** A Lumen that hasn't answered for this long has gone. */
const GONE_MS = 10_000
/** How long a play request waits for Lumen's answer. */
const REPLY_MS = 2500

interface Found {
  name: string
  /** Where it answered from on the network (not this computer's loopback). */
  address: string
  /** When it last answered on 127.0.0.1, i.e. it's on this computer (0: never). */
  local: number
  version: string
  ready: boolean
  allowed: boolean
  countdowns: number
  outro: string | null
  music: string | null
  logo: string | null
  can: Partial<Record<LumenWhat, string | null>> | null
  seen: number
}

/** The broadcast address of each IPv4 network this computer is on. */
function broadcasts(): string[] {
  const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
  const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue
      const mask = toInt(a.netmask)
      out.push(toIp(((toInt(a.address) & mask) | ~mask) >>> 0))
    }
  }
  return out
}

export class LumenLink {
  private socket: dgram.Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private found = new Map<string, Found>()
  private waiting = new Map<string, (reply: { ok: boolean; message: string | null }) => void>()
  private blocked = false
  /** The network questions of the current look, and how many failed: blocked if all of them do. */
  private round = { sent: 0, failed: 0, done: 0 }
  private lastSent = ''
  private seq = 0

  constructor(private readonly onChange: (s: LumenState) => void) {}

  start() {
    const socket = dgram.createSocket('udp4')
    this.socket = socket
    socket.on('message', (msg, rinfo) => this.receive(msg, rinfo.address))
    socket.on('error', () => {})
    socket.bind(0, () => socket.setBroadcast(true))
  }

  stop() {
    this.setLooking(false)
    this.socket?.close()
    this.socket = null
  }

  /** While the boxes show, Lumen is looked for; otherwise Player sends nothing. */
  setLooking(on: boolean) {
    if (on && !this.timer) {
      this.look()
      this.timer = setInterval(() => this.look(), LOOK_MS)
    } else if (!on && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  state(): LumenState {
    const lumen = this.chosen()
    return {
      lumen: lumen
        ? {
            name: lumen.name,
            ready: lumen.ready,
            allowed: lumen.allowed,
            countdowns: lumen.countdowns,
            outro: lumen.outro,
            music: lumen.music,
            logo: lumen.logo,
            can: lumen.can,
          }
        : null,
      others: Math.max(0, this.found.size - 1),
      blocked: this.blocked && this.found.size === 0,
    }
  }

  /** Asks Lumen to play a random countdown or the outro, or to fade its music out over `seconds`. */
  async play(what: LumenWhat, seconds?: number): Promise<LumenPlayResult> {
    let lumen = this.chosen()
    if (!lumen) {
      // Not heard from yet: ask, and give it a moment.
      this.look()
      await new Promise((r) => setTimeout(r, 800))
      lumen = this.chosen()
    }
    if (!lumen) return { ok: false, message: 'Lumen wasn’t found on the network. Check it’s open, on the same network, and allowed to use it.' }
    const id = `${process.pid}-${++this.seq}`
    const reply = new Promise<{ ok: boolean; message: string | null } | null>((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(id)
        resolve(null)
      }, REPLY_MS)
      this.waiting.set(id, (r) => {
        clearTimeout(t)
        resolve(r)
      })
    })
    // Lumen on this computer is asked on 127.0.0.1, which keeps working when the network changes
    // (Wi-Fi drops, a new address) and is never blocked by macOS.
    const to = Date.now() - lumen.local < GONE_MS ? '127.0.0.1' : lumen.address
    this.send({ app: APP, v: 1, cmd: 'play', what, id, ...(seconds !== undefined ? { seconds } : {}) }, to, true)
    // Lumen only answers: ask again straight away, so the boxes show what's changed (the music gone).
    setTimeout(() => this.look(), 300)
    const r = await reply
    if (!r) return { ok: false, message: `Lumen on “${lumen.name}” didn’t answer.` }
    return { ok: r.ok, message: r.message, lumen: lumen.name }
  }

  /** The Lumen the boxes use: one that lets Player play, else any, the most recently heard first. */
  private chosen(): Found | null {
    const list = [...this.found.values()].sort((a, b) => Number(b.allowed) - Number(a.allowed) || b.seen - a.seen)
    return list[0] ?? null
  }

  private look() {
    const now = Date.now()
    let changed = false
    for (const [key, f] of this.found) {
      if (now - f.seen > GONE_MS) {
        this.found.delete(key)
        changed = true
      }
    }
    if (changed) this.emit()
    const hello = { app: APP, v: 1, cmd: 'hello' }
    // Lumen on this computer, then on the network.
    this.send(hello, '127.0.0.1', true)
    this.round = { sent: 0, failed: 0, done: 0 }
    this.send(hello, '255.255.255.255')
    for (const b of broadcasts()) this.send(hello, b)
  }

  private receive(msg: Buffer, from: string) {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(msg.toString('utf8'))
    } catch {
      return
    }
    if (m?.app !== APP || m.v !== 1) return
    this.blocked = false
    if (m.type === 'hello' && typeof m.name === 'string') {
      // One entry per copy of Lumen: by its name (the same Lumen can answer on two addresses).
      const key = m.name
      // On this computer it answers on 127.0.0.1 as well as on its network address.
      const prev = this.found.get(key)
      const loopback = from === '127.0.0.1'
      this.found.set(key, {
        name: m.name,
        address: loopback ? (prev?.address ?? from) : from,
        local: loopback ? Date.now() : (prev?.local ?? 0),
        version: String(m.version ?? ''),
        ready: m.ready === true,
        allowed: m.allowed === true,
        countdowns: typeof m.countdowns === 'number' ? m.countdowns : 0,
        outro: typeof m.outro === 'string' ? m.outro : null,
        music: typeof m.music === 'string' ? m.music : null,
        logo: typeof (m.details as { logo?: unknown } | undefined)?.logo === 'string' ? (m.details as { logo: string }).logo : null,
        can: m.can && typeof m.can === 'object' ? (m.can as Partial<Record<LumenWhat, string | null>>) : null,
        seen: Date.now(),
      })
      this.emit()
    } else if (m.type === 'played' && typeof m.id === 'string') {
      this.waiting.get(m.id)?.({ ok: m.ok === true, message: typeof m.message === 'string' ? m.message : null })
      this.waiting.delete(m.id)
    }
  }

  /**
   * `quiet`: its failure doesn't count. Otherwise it's one of a look's network questions: macOS
   * refuses them all until Player is allowed the local network (Local Network privacy), so when
   * all of them fail Player is blocked, and once they go through again (allowed) it isn't.
   */
  private send(body: object, address: string, quiet = false) {
    const round = this.round
    if (!quiet) round.sent++
    this.socket?.send(Buffer.from(JSON.stringify(body)), PORT, address, (err) => {
      if (quiet || round !== this.round) return
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'EHOSTUNREACH' || code === 'EPERM' || code === 'ENETDOWN') round.failed++
      if (++round.done < round.sent) return
      const blocked = round.failed === round.sent
      if (blocked !== this.blocked) {
        this.blocked = blocked
        this.emit()
      }
    })
  }

  private emit() {
    const s = this.state()
    const json = JSON.stringify(s)
    if (json === this.lastSent) return
    this.lastSent = json
    this.onChange(s)
  }
}
