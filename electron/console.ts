// The console button's link to a Behringer / Midas X32 on the local network.
//
// The X32 speaks OSC over UDP port 10023 and answers whatever address and port asked: an address
// with no value reads it, with a value sets it. `/xinfo` makes it say who it is, and `/xremote`
// makes it push every change to us for the next 10 seconds. This is the same protocol FaderLink
// uses; Player talks to the console directly, so FaderLink doesn't have to be running.
//
// Player only looks for consoles while it has a reason to: a console button is set up (so its
// console is found again, at whatever address it's on now), or the user is setting one up (a
// search, started by the picker). Otherwise it sends nothing on the network.

import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import type { ConsoleState, ConsoleStrip, ConsoleTarget, KnownConsole } from '../src/platform/types'

const PORT = 10023
/** How often consoles are looked for, and the linked one asked how it is. */
const TICK_MS = 2000
/** A console that hasn't answered for this long has gone. */
const GONE_MS = 7000
/** Every address on the subnet is asked this often while no console is found (broadcasts may be filtered). */
const SWEEP_MS = 30_000
/** How long a search started from the Console Button picker lasts (it's renewed while the picker is open). */
const SEARCH_MS = 60_000

// ------------------------------------------------------------------------------- OSC

type OscArg = { type: 'i'; value: number } | { type: 'f'; value: number } | { type: 's'; value: string }

/** A string, its terminating zero, then zeros to the next multiple of 4 bytes. */
function oscString(s: string): Buffer {
  const raw = Buffer.from(s + '\0', 'utf8')
  return Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)])
}

export function encode(address: string, args: OscArg[] = []): Buffer {
  const parts = [oscString(address), oscString(',' + args.map((a) => a.type).join(''))]
  for (const a of args) {
    if (a.type === 's') {
      parts.push(oscString(a.value))
    } else {
      const b = Buffer.alloc(4)
      if (a.type === 'i') b.writeInt32BE(a.value)
      else b.writeFloatBE(a.value)
      parts.push(b)
    }
  }
  return Buffer.concat(parts)
}

export function decode(buf: Buffer): { address: string; args: (number | string)[] } | null {
  let off = 0
  const str = () => {
    const end = buf.indexOf(0, off)
    if (end < 0) throw new Error('truncated')
    const s = buf.toString('utf8', off, end)
    off = (end + 4) & ~3
    return s
  }
  try {
    const address = str()
    if (!address.startsWith('/')) return null
    const args: (number | string)[] = []
    if (off < buf.length) {
      const tags = str()
      if (tags.startsWith(',')) {
        for (const t of tags.slice(1)) {
          if (t === 'i' || t === 'f') {
            args.push(t === 'i' ? buf.readInt32BE(off) : buf.readFloatBE(off))
            off += 4
          } else if (t === 's') {
            args.push(str())
          } else {
            return null
          }
        }
      }
    }
    return { address, args }
  } catch {
    return null
  }
}

// --------------------------------------------------------------------------- strips

const two = (n: number) => String(n).padStart(2, '0')

/** Where a strip's on/off lives: 1 is on, 0 muted. DCAs have no /mix level. */
export const onAddress = (t: ConsoleTarget) =>
  t.kind === 'dca' ? `/dca/${t.number}/on` : `/${t.kind === 'channel' ? 'ch' : 'bus'}/${two(t.number)}/mix/on`

export const nameAddress = (t: ConsoleTarget) =>
  t.kind === 'dca' ? `/dca/${t.number}/config/name` : `/${t.kind === 'channel' ? 'ch' : 'bus'}/${two(t.number)}/config/name`

const COUNTS = { channel: 32, bus: 16, dca: 8 } as const

/** Every strip the button can be linked to. */
export const ALL_TARGETS: ConsoleTarget[] = (['channel', 'bus', 'dca'] as const).flatMap((kind) =>
  Array.from({ length: COUNTS[kind] }, (_, i) => ({ kind, number: i + 1 })),
)

export function isTarget(v: unknown): v is ConsoleTarget {
  if (typeof v !== 'object' || !v) return false
  const t = v as ConsoleTarget
  return (t.kind === 'channel' || t.kind === 'bus' || t.kind === 'dca') && Number.isInteger(t.number) && t.number >= 1 && t.number <= COUNTS[t.kind]
}

const sameTarget = (a: ConsoleTarget | null, b: ConsoleTarget | null) => a?.kind === b?.kind && a?.number === b?.number

// -------------------------------------------------------------------------- network

/** IPv4 networks this computer is on: broadcast address and every other host, as dotted strings. */
function localNetworks() {
  const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
  const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
  const nets: { broadcast: string; hosts: string[] }[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue
      const ip = toInt(a.address)
      const mask = toInt(a.netmask)
      const size = ~mask >>> 0
      if (size < 2) continue
      const base = (ip & mask) >>> 0
      const hosts: string[] = []
      // Small subnets only: sweeping more would be rude.
      if (size <= 1024) for (let h = 1; h < size; h++) if (((base | h) >>> 0) !== ip) hosts.push(toIp((base | h) >>> 0))
      nets.push({ broadcast: toIp((base | size) >>> 0), hosts })
    }
  }
  return nets
}

// -------------------------------------------------------------------------- service

interface Online {
  address: string
  model: string
  seen: number
}

export class ConsoleLink {
  private socket: dgram.Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private lastSweep = 0
  private consoles: KnownConsole[] = []
  /** The console and strip the button is for; see choose(). */
  private current: { name: string; target: ConsoleTarget } | null = null
  private online = new Map<string, Online>()
  /** Consoles already asked about this run, so a "Not Now" isn't asked again straight away. */
  private asked = new Set<string>()
  private newConsole: ConsoleState['newConsole'] = null
  private label = ''
  private muted: boolean | null = null
  private blocked = false
  /** The network questions of the current tick, and how many failed: blocked if all of them do. */
  private round = { sent: 0, failed: 0, done: 0 }
  /** Until when a search asked for by the user runs (see search()). */
  private searchUntil = 0
  private lastSent = ''
  /** Gathers replies while the picker asks a console for its strip names. */
  private collector: ((address: string, m: { address: string; args: (number | string)[] }) => void) | null = null

  constructor(
    private readonly file: string,
    private readonly onChange: (s: ConsoleState) => void,
  ) {}

  start() {
    this.consoles = this.load()
    this.choose()
    const socket = dgram.createSocket('udp4')
    this.socket = socket
    socket.on('message', (msg, rinfo) => this.receive(msg, rinfo.address))
    socket.on('error', () => {})
    socket.bind(0, () => {
      socket.setBroadcast(true)
      this.tick()
      this.timer = setInterval(() => this.tick(), TICK_MS)
    })
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.save()
    this.socket?.close()
    this.socket = null
  }

  state(): ConsoleState {
    const b = this.buttonConsole()
    const online = b ? this.online.has(b.name) : false
    return {
      consoles: this.consoles.map((c) => ({ ...c })),
      online: [...this.online.keys()],
      button: b?.target
        ? { console: b.name, target: b.target, label: this.label, online, muted: online ? this.muted : null }
        : null,
      models: Object.fromEntries([...this.online].map(([name, o]) => [name, o.model])),
      newConsole: this.newConsole,
      blocked: this.blocked && this.online.size === 0,
      searching: this.searching(),
    }
  }

  /**
   * Looks for consoles for the next minute, every address on the network included: the Console
   * Button picker asks for this while it's open, when no button is set up yet.
   */
  search() {
    const first = !this.searching()
    this.searchUntil = Date.now() + SEARCH_MS
    if (first) {
      this.lastSweep = 0
      this.tick()
    }
    this.emit()
  }

  async link(name: string, target: ConsoleTarget | null) {
    let c = this.consoles.find((x) => x.name === name)
    if (!c) {
      const seen = this.online.get(name) ?? (this.newConsole?.name === name ? this.newConsole : null)
      if (!seen) throw new Error(`Console “${name}” isn't on the network`)
      c = { name, model: seen.model, address: seen.address, lastSeen: Date.now(), target: null }
      this.consoles.push(c)
    }
    c.target = target
    if (this.newConsole?.name === name) this.newConsole = null
    this.save()
    // A console just linked by hand is the one the button shows.
    this.choose(target ? name : undefined)
    this.emit()
  }

  async forget(name: string) {
    this.consoles = this.consoles.filter((c) => c.name !== name)
    // Not asked about as a new console straight away, just because it's still on the network.
    this.asked.add(name)
    if (this.newConsole?.name === name) this.newConsole = null
    this.save()
    this.choose()
    this.emit()
  }

  async setMuted(muted: boolean) {
    const b = this.buttonConsole()
    const at = b && this.online.get(b.name)
    if (!b?.target || !at) throw new Error('The console isn’t on the network')
    this.send(encode(onAddress(b.target), [{ type: 'i', value: muted ? 0 : 1 }]), at.address)
    this.muted = muted
    this.emit()
    // Read it back, which also corrects the button if the console didn't take it.
    setTimeout(() => this.send(encode(onAddress(b.target!)), at.address), 150)
  }

  /** Asks an online console for the names of everything the button can link to. */
  strips(name: string): Promise<ConsoleStrip[]> {
    const at = this.online.get(name)
    if (!at) return Promise.reject(new Error(`Console “${name}” isn’t on the network`))
    const names = new Map<string, string>()
    this.collector = (from, m) => {
      if (from === at.address && typeof m.args[0] === 'string') names.set(m.address, m.args[0])
    }
    for (const t of ALL_TARGETS) this.send(encode(nameAddress(t)), at.address)
    return new Promise((resolve) => {
      setTimeout(() => {
        this.collector = null
        resolve(ALL_TARGETS.map((target) => ({ target, label: names.get(nameAddress(target)) ?? '' })))
      }, 900)
    })
  }

  // ------------------------------------------------------------------------ internals

  /** The linked console the button is showing (see choose()). */
  private buttonConsole(): KnownConsole | null {
    return (this.current && this.consoles.find((c) => c.name === this.current!.name && c.target)) || null
  }

  /**
   * Decides which linked console the button is for. It stays with the one it has while that one
   * is on the network, so two linked consoles online at once can't make it flip between them.
   * Otherwise: `prefer` (just linked by hand), else the linked console online that was seen most
   * recently, else the most recently seen of all (shown greyed out). When the choice changes,
   * the old strip's name and mute are dropped and the new console is asked. True if it changed.
   */
  private choose(prefer?: string): boolean {
    const linked = this.consoles.filter((c) => c.target)
    const online = linked.filter((c) => this.online.has(c.name))
    const latest = (list: KnownConsole[]) => [...list].sort((a, b) => b.lastSeen - a.lastSeen)[0] ?? null
    const preferred = prefer ? linked.find((c) => c.name === prefer) : undefined
    const kept = linked.find((c) => c.name === this.current?.name)
    const next =
      preferred ?? (kept && (this.online.has(kept.name) || online.length === 0) ? kept : (latest(online) ?? latest(linked)))
    const changed = next?.name !== this.current?.name || !sameTarget(next?.target ?? null, this.current?.target ?? null)
    this.current = next?.target ? { name: next.name, target: { ...next.target } } : null
    if (changed) {
      this.label = ''
      this.muted = null
      this.pollButton(true)
    }
    return changed
  }

  private tick() {
    this.ticks++
    const now = Date.now()

    // Consoles that stopped answering have gone.
    let changed = false
    for (const [name, o] of this.online) {
      if (now - o.seen > GONE_MS) {
        this.online.delete(name)
        changed = true
      }
    }
    if (changed) {
      this.choose()
      if (!this.buttonOnline()) this.muted = null
    }

    // Nothing to look for: no button, and no one setting one up. Stay quiet on the network.
    // (emit() sends only what changed: a search that has just ended, say.)
    if (!this.hasButton() && !this.searching()) {
      this.emit()
      return
    }

    // Who's there: every remembered console directly, then a broadcast on each network.
    // (Only the broadcasts' errors count as "blocked": a remembered console that's switched
    // off can make its own address fail too.)
    const xinfo = encode('/xinfo')
    for (const c of this.consoles) this.send(xinfo, c.address, true)
    const nets = localNetworks()
    this.round = { sent: 0, failed: 0, done: 0 }
    this.send(xinfo, '255.255.255.255')
    for (const n of nets) this.send(xinfo, n.broadcast)
    if (this.online.size === 0 && now - this.lastSweep > SWEEP_MS) {
      this.lastSweep = now
      for (const n of nets) for (const h of n.hosts) this.send(xinfo, h, true)
    }

    this.pollButton(this.ticks % 4 === 1)
    this.emit()
  }

  /** A button is set up: its console is looked for all the time. */
  private hasButton() {
    return this.consoles.some((c) => c.target)
  }

  private searching() {
    return Date.now() < this.searchUntil
  }

  private buttonOnline() {
    const b = this.buttonConsole()
    return !!b && this.online.has(b.name)
  }

  /** Asks the button's console for its strip's state; with `subscribe`, renews /xremote too. */
  private pollButton(subscribe: boolean) {
    const b = this.buttonConsole()
    const at = b && this.online.get(b.name)
    if (!b?.target || !at) return
    if (subscribe) this.send(encode('/xremote'), at.address)
    this.send(encode(onAddress(b.target)), at.address)
    this.send(encode(nameAddress(b.target)), at.address)
  }

  private receive(msg: Buffer, from: string) {
    const m = decode(msg)
    if (!m) return
    this.blocked = false

    if (m.address === '/xinfo') {
      const [, name, model] = m.args
      if (typeof name !== 'string' || !name) return
      const wasOnline = this.online.has(name)
      this.online.set(name, { address: from, model: String(model ?? ''), seen: Date.now() })
      const known = this.consoles.find((c) => c.name === name)
      if (known) {
        known.lastSeen = Date.now()
        if (known.address !== from || known.model !== model) {
          known.address = from
          known.model = String(model ?? known.model)
          this.save()
        }
      } else if (this.hasButton() && !this.searching() && !this.newConsole && !this.asked.has(name)) {
        // Another console, with a button already set up: ask about it once. (While the user is
        // setting the button up, the picker shows the consoles found instead.)
        this.asked.add(name)
        this.newConsole = { name, model: String(model ?? ''), address: from }
      }
      if (!wasOnline) {
        // A linked console arriving may take over a button whose console is away.
        if (!this.choose() && this.buttonConsole()?.name === name) this.pollButton(true)
        this.emit()
      }
      return
    }

    this.collector?.(from, m)

    // The button's strip: replies to our questions, or pushed when it changes on the console.
    const b = this.buttonConsole()
    const at = b && this.online.get(b.name)
    if (!b?.target || !at || at.address !== from) return
    const value = m.args[0]
    if (m.address === onAddress(b.target) && typeof value === 'number') {
      const muted = value === 0
      if (muted !== this.muted) {
        this.muted = muted
        this.emit()
      }
    } else if (m.address === nameAddress(b.target) && typeof value === 'string' && value !== this.label) {
      this.label = value
      this.emit()
    }
  }

  /**
   * `quiet`: its failure doesn't count. Otherwise it's one of a tick's broadcasts: macOS refuses
   * them all until Player is allowed the local network (Local Network privacy), so when all of
   * them fail Player is blocked, and once they go through again (allowed) it isn't.
   */
  private send(packet: Buffer, address: string, quiet = false) {
    const round = this.round
    if (!quiet) round.sent++
    this.socket?.send(packet, PORT, address, (err) => {
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

  /** Tells the window, when anything it shows has changed. */
  private emit() {
    const s = this.state()
    const json = JSON.stringify(s)
    if (json === this.lastSent) return
    this.lastSent = json
    this.onChange(s)
  }

  private load(): KnownConsole[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const list: unknown[] = Array.isArray(data?.consoles) ? data.consoles : []
      return list.flatMap((c) => {
        const k = c as KnownConsole
        if (typeof k?.name !== 'string' || !k.name || typeof k.address !== 'string') return []
        return [{
          name: k.name,
          model: typeof k.model === 'string' ? k.model : '',
          address: k.address,
          lastSeen: typeof k.lastSeen === 'number' ? k.lastSeen : 0,
          target: isTarget(k.target) ? { kind: k.target.kind, number: k.target.number } : null,
        }]
      })
    } catch {
      return []
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, consoles: this.consoles }, null, 2))
    } catch {
      /* not writable: remembered for this run only */
    }
  }
}
