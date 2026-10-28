import { barLength, renderClick } from './synth'
import {
  type Bus,
  type ChannelSettings,
  CLICK_CHANNELS,
  type Song,
  busGroupName,
  busTopChannel,
  normalizeBus,
  parseBus,
  sectionEnd,
} from './types'

export type JumpMode = 'immediate' | 'bar' | 'section'

interface Channel {
  id: string
  name: string
  group: 'click' | 'stem'
  buffer: AudioBuffer | null
  /** Sources connect here. */
  input: GainNode
  gain: GainNode
  panner: StereoPannerNode
  analyser: AnalyserNode
  settings: ChannelSettings
  /** One of the loaded song's stems (removed when another song loads). */
  fromSong: boolean
  /** The bus it's grouped under in the Buses view (stems only): "EG 1" → "EG". */
  busGroup: string | null
}

/** A bus in the Buses view: a fader, mute and solo over a group of stems. */
export interface GroupSettings {
  volume: number
  mute: boolean
  solo: boolean
}

/** Repeat a section once and carry on, or until the loop is turned off. */
export type LoopMode = 'once' | 'forever'

/** Per-route output stage: its own fade, master and limiter, then into the device channels. */
interface Output {
  input: GainNode
  fade: GainNode
  master: GainNode
  limiter: DynamicsCompressorNode
  splitter: ChannelSplitterNode | null
}

interface Loop {
  sectionId: string
  start: number
  end: number
  mode: LoopMode
}

interface PendingJump {
  sectionId: string
  when: number
}

export interface EngineState {
  playing: boolean
  loop: Loop | null
  pendingJump: PendingJump | null
  /** A fade in progress: in (from Fade while stopped) or out (Fade while playing). */
  fade: 'in' | 'out' | null
  channels: { id: string; name: string; group: 'click' | 'stem'; busGroup: string | null; settings: ChannelSettings }[]
  /** The loaded song's buses (stems grouped by name), in mixer order. */
  groups: { name: string; settings: GroupSettings; members: string[] }[]
  masterVolume: number
  /** Channels on the current output device (2 for plain stereo). */
  outputCount: number
  /** '' means the system default device. */
  outputDeviceId: string
  /** The song's own click stem is playing as the click (the generated one is silent). */
  audioClick: boolean
}

const MIX_KEY = 'player.mix.v1'
const OUTPUT_KEY = 'player.output.v1'

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

const DEFAULT_SETTINGS: ChannelSettings = { volume: 0.75, mute: false, solo: false, bus: 'main' }
const GROUP_PREFIX = 'bus:'

/** Fader position (0..1) to linear gain. 0.75 is unity, 1.0 is about +6 dB. */
export function faderToGain(p: number): number {
  if (p <= 0) return 0
  return Math.pow(p / 0.75, 2.4)
}

export function faderToDb(p: number): string {
  const g = faderToGain(p)
  if (g <= 0.0001) return '-∞'
  const db = 20 * Math.log10(g)
  return (db > 0 ? '+' : '') + db.toFixed(1)
}

function peakOf(a: AnalyserNode): number {
  const data = new Float32Array(a.fftSize)
  a.getFloatTimeDomainData(data)
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  return peak
}

function loadMix(): Record<string, Partial<ChannelSettings>> {
  try {
    return JSON.parse(localStorage.getItem(MIX_KEY) || '{}')
  } catch {
    return {}
  }
}

export class Engine {
  readonly ctx: AudioContext
  private outputs = new Map<Bus, Output>()
  private merger!: ChannelMergerNode
  private outputCount = 0
  private outputDeviceId = ''
  private clickBus!: Channel
  private channels = new Map<string, Channel>()
  private groups = new Map<string, GroupSettings>()
  private order: string[] = []
  private masterMeters: [AnalyserNode, AnalyserNode] | null = null
  private sources: AudioBufferSourceNode[] = []
  private sourceChannel = new WeakMap<AudioBufferSourceNode, Channel>()
  private song: Song | null = null
  /** Overlap / Crossfade: when playback crosses this point the next song is handed in. */
  private handoffAt: number | null = null
  private handoffListeners = new Set<() => void>()
  private lastTickPos: number | null = null

  private playing = false
  private startCtxTime = 0
  private startOffset = 0
  /** Timeline base in effect before a scheduled (quantised) jump lands. */
  private prevBase: { ctxTime: number; offset: number } | null = null
  private pausedPos = 0
  private loop: Loop | null = null
  private pendingJump: PendingJump | null = null
  private fading: 'in' | 'out' | null = null
  private fadeTimer: number | undefined
  private masterVolume = 0.75
  private listeners = new Set<() => void>()
  private endedListeners = new Set<() => void>()
  private state: EngineState
  private tickTimer: number
  private midi: MIDIOutput[] = []
  midiMuted = false
  fadeSeconds = 4

  /** `ctx` is injectable so tests can render the graph offline with any channel count. */
  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' })
    const saved = loadMix()
    if (typeof saved.__master?.volume === 'number') this.masterVolume = saved.__master.volume
    this.configureOutputs()
    for (const c of CLICK_CHANNELS) {
      const ch = this.createChannel(c.id, c.name, 'click')
      if (c.id === 'click') this.clickBus = ch
    }
    this.state = this.buildState()
    this.tickTimer = window.setInterval(() => this.tick(), 30)
    this.ctx.addEventListener('sinkchange', () => {
      this.configureOutputs()
      this.emit()
    })
    this.initMidi()
  }

  // ----------------------------------------------------------------- outputs

  /** Matches the graph to the device: every channel it exposes becomes a routable output. */
  private configureOutputs() {
    const dest = this.ctx.destination
    const n = Math.max(2, Math.min(32, dest.maxChannelCount || 2))
    if (n === this.outputCount) return
    this.outputCount = n
    dest.channelCount = n
    dest.channelCountMode = 'explicit'
    dest.channelInterpretation = 'discrete'
    this.merger?.disconnect()
    this.merger = this.ctx.createChannelMerger(n)
    this.merger.connect(dest)
    // Main 1/2 metered on the Master strip.
    const split = this.ctx.createChannelSplitter(n)
    this.merger.connect(split)
    this.masterMeters = [this.ctx.createAnalyser(), this.ctx.createAnalyser()]
    this.masterMeters.forEach((a, i) => {
      a.fftSize = 512
      split.connect(a, i)
    })
    for (const [bus, out] of this.outputs) this.connectOutput(bus, out)
    for (const ch of this.channels.values()) this.route(ch)
  }

  private connectOutput(bus: Bus, out: Output) {
    out.limiter.disconnect()
    out.splitter?.disconnect()
    out.splitter = null
    if (busTopChannel(bus) >= this.outputCount) return
    const { kind, index } = parseBus(bus)
    if (kind === 'mono') {
      out.limiter.connect(this.merger, 0, index)
    } else {
      out.splitter = this.ctx.createChannelSplitter(2)
      out.limiter.connect(out.splitter)
      out.splitter.connect(this.merger, 0, index * 2)
      out.splitter.connect(this.merger, 1, index * 2 + 1)
    }
  }

  private output(bus: Bus): Output {
    let out = this.outputs.get(bus)
    if (out) return out
    const ctx = this.ctx
    const input = ctx.createGain()
    if (parseBus(bus).kind === 'mono') {
      // Fold whatever arrives (mono click, stereo stem) to one channel.
      input.channelCount = 1
      input.channelCountMode = 'explicit'
    }
    const fade = ctx.createGain()
    fade.gain.value = this.fading === 'out' ? 0 : 1
    const master = ctx.createGain()
    master.gain.value = faderToGain(this.masterVolume)
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -1
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.1
    input.connect(fade).connect(master).connect(limiter)
    out = { input, fade, master, limiter, splitter: null }
    this.outputs.set(bus, out)
    this.connectOutput(bus, out)
    return out
  }

  /** Falls back to Main when a route needs more outputs than the device has. */
  private effectiveBus(bus: Bus): Bus {
    return busTopChannel(bus) < this.outputCount ? bus : 'main'
  }

  private route(ch: Channel) {
    ch.gain.disconnect()
    ch.panner.disconnect()
    ch.gain.connect(ch.analyser)
    if (ch.group === 'click' && ch.id !== 'click') {
      // Click sub-channels always feed the Click bus, which carries the routing.
      ch.gain.connect(ch.panner).connect(this.clickBus.input)
      return
    }
    const bus = this.effectiveBus(ch.settings.bus)
    if (parseBus(bus).kind === 'mono') ch.gain.connect(this.output(bus).input)
    else ch.gain.connect(ch.panner).connect(this.output(bus).input)
  }

  get canSelectOutput(): boolean {
    return typeof (this.ctx as SinkContext).setSinkId === 'function'
  }

  /** Switches the audio device ('' = system default). Routing adapts to its channel count. */
  async setOutputDevice(deviceId: string, label = '') {
    const ctx = this.ctx as SinkContext
    if (!ctx.setSinkId) throw new Error('This runtime cannot choose an audio output device')
    await ctx.setSinkId(deviceId)
    this.outputDeviceId = deviceId
    this.configureOutputs()
    try {
      localStorage.setItem(OUTPUT_KEY, JSON.stringify({ deviceId, label }))
    } catch {
      /* storage unavailable */
    }
    this.emit()
  }

  /** Reconnects to the last-used device if it's plugged in. */
  async restoreOutputDevice(available: MediaDeviceInfo[]) {
    let saved: { deviceId?: string } = {}
    try {
      saved = JSON.parse(localStorage.getItem(OUTPUT_KEY) || '{}')
    } catch {
      /* ignore */
    }
    if (!saved.deviceId || !this.canSelectOutput) return
    if (!available.some((d) => d.kind === 'audiooutput' && d.deviceId === saved.deviceId)) return
    try {
      await this.setOutputDevice(saved.deviceId)
    } catch {
      /* device refused; stay on default */
    }
  }

  // ---------------------------------------------------------------- channels

  private createChannel(id: string, name: string, group: 'click' | 'stem', fromSong = false): Channel {
    const saved = loadMix()[id] ?? {}
    const input = this.ctx.createGain()
    const gain = this.ctx.createGain()
    const panner = this.ctx.createStereoPanner()
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 512
    input.connect(gain)
    const ch: Channel = {
      id,
      name,
      group,
      buffer: null,
      input,
      gain,
      panner,
      analyser,
      settings: { ...DEFAULT_SETTINGS, ...saved, solo: false, bus: normalizeBus(saved.bus ?? 'main') },
      fromSong,
      busGroup: group === 'stem' ? busGroupName(name) : null,
    }
    if (ch.busGroup && !this.groups.has(ch.busGroup)) {
      const g = loadMix()[GROUP_PREFIX + ch.busGroup] ?? {}
      this.groups.set(ch.busGroup, { volume: g.volume ?? 0.75, mute: g.mute ?? false, solo: false })
    }
    this.channels.set(id, ch)
    this.order.push(id)
    this.route(ch)
    return ch
  }

  /**
   * Solo works in two places: stems and buses (soloing the Click bus leaves just the click), and
   * the click's own parts among themselves. A stem solo never silences the click.
   */
  private applyGains() {
    const all = [...this.channels.values()]
    const grp = (c: Channel) => (c.busGroup ? this.groups.get(c.busGroup) : undefined)
    const stemSolo = all.some((c) => c.group === 'stem' && (c.settings.solo || grp(c)?.solo))
    const clickSolo = this.channels.get('click')?.settings.solo ?? false
    const partSolo = all.some((c) => c.group === 'click' && c.id !== 'click' && c.settings.solo)
    const now = this.ctx.currentTime
    for (const ch of all) {
      const s = ch.settings
      const g = grp(ch)
      let on = !s.mute && !g?.mute
      if (ch.group === 'stem') on &&= stemSolo ? s.solo || !!g?.solo : !clickSolo
      else if (ch.id !== 'click') on &&= !partSolo || s.solo
      const gain = on ? faderToGain(s.volume) * (g ? faderToGain(g.volume) : 1) : 0
      ch.gain.gain.setTargetAtTime(gain, now, 0.01)
    }
  }

  private saveMix() {
    const out: Record<string, Partial<ChannelSettings>> = loadMix()
    for (const ch of this.channels.values()) {
      out[ch.id] = { volume: ch.settings.volume, mute: ch.settings.mute, bus: ch.settings.bus }
    }
    for (const [name, g] of this.groups) out[GROUP_PREFIX + name] = { volume: g.volume, mute: g.mute }
    out.__master = { volume: this.masterVolume }
    try {
      localStorage.setItem(MIX_KEY, JSON.stringify(out))
    } catch {
      /* storage unavailable */
    }
  }

  setChannel(id: string, patch: Partial<ChannelSettings>) {
    const ch = this.channels.get(id)
    if (!ch) return
    ch.settings = { ...ch.settings, ...patch }
    if (patch.bus !== undefined) this.route(ch)
    this.applyGains()
    this.saveMix()
    this.emit()
  }

  /** A bus in the Buses view: its fader, mute and solo apply on top of its stems' own. */
  setGroup(name: string, patch: Partial<GroupSettings>) {
    const g = this.groups.get(name)
    if (!g) return
    this.groups.set(name, { ...g, ...patch })
    this.applyGains()
    this.saveMix()
    this.emit()
  }

  setMasterVolume(v: number) {
    this.masterVolume = v
    for (const out of this.outputs.values()) out.master.gain.setTargetAtTime(faderToGain(v), this.ctx.currentTime, 0.01)
    this.saveMix()
    this.emit()
  }

  /** Peak level (0..1+) of a channel's post-fader signal, for metering. */
  meter(id: string): number {
    const ch = this.channels.get(id)
    if (!ch || !this.playing) return 0
    return peakOf(ch.analyser)
  }

  /** A bus's level: the loudest of its stems. */
  groupMeter(name: string): number {
    if (!this.playing) return 0
    let peak = 0
    for (const ch of this.channels.values()) if (ch.busGroup === name) peak = Math.max(peak, peakOf(ch.analyser))
    return peak
  }

  /** Left and right of Main 1/2, after the master fader and limiter. */
  masterMeter(): [number, number] {
    if (!this.masterMeters || !this.playing) return [0, 0]
    return [peakOf(this.masterMeters[0]), peakOf(this.masterMeters[1])]
  }

  // -------------------------------------------------------------------- song

  /** Loads a song (with stems already decoded/rendered). Stops playback. */
  load(song: Song) {
    this.stopSources()
    this.playing = false
    this.pausedPos = 0
    this.loop = null
    this.pendingJump = null
    this.song = song
    this.dropSongChannels()
    for (const stem of song.stems) {
      // A click stem (e.g. MultiTracks' Click Track) joins the click group and feeds the Click bus.
      const ch = this.createChannel(stem.id, stem.name, stem.id === song.clickStem ? 'click' : 'stem', true)
      ch.buffer = stem.buffer
    }
    this.regenerateClick()
    this.applyGains()
    this.emit()
  }

  /**
   * Overlap / Crossfade: loads the next song and starts it while this one's stems play out
   * underneath, or fade out over `crossfade` seconds as the next song fades in.
   */
  async handOff(next: Song, crossfade: number | null) {
    if (this.playing) this.ringOut(crossfade)
    this.load(next)
    if (crossfade) {
      const now = this.ctx.currentTime
      for (const ch of this.channels.values()) {
        if (!ch.fromSong || ch.group !== 'stem') continue
        ch.input.gain.setValueAtTime(0, now)
        ch.input.gain.linearRampToValueAtTime(1, now + crossfade)
      }
    }
    await this.play()
  }

  /** Takes the playing song's stems out of the mixer but leaves them sounding until they end (or fade). */
  private ringOut(fade: number | null) {
    const keep = this.sources.filter((s) => {
      const ch = this.sourceChannel.get(s)
      return ch?.fromSong && ch.group === 'stem'
    })
    if (!keep.length) return
    this.sources = this.sources.filter((s) => !keep.includes(s))
    const chans = new Set(keep.map((s) => this.sourceChannel.get(s)!))
    for (const ch of chans) {
      this.channels.delete(ch.id)
      this.order = this.order.filter((o) => o !== ch.id)
    }
    const now = this.ctx.currentTime
    let left = keep.length
    for (const s of keep) {
      s.onended = () => {
        s.disconnect()
        if (--left > 0) return
        for (const ch of chans) {
          ch.gain.disconnect()
          ch.panner.disconnect()
        }
      }
      if (fade) {
        try {
          s.stop(now + fade)
        } catch {
          /* already over */
        }
      }
    }
    if (fade) {
      for (const ch of chans) {
        ch.input.gain.setValueAtTime(ch.input.gain.value, now)
        ch.input.gain.linearRampToValueAtTime(0, now + fade)
      }
    }
  }

  /** Where the next song is handed in (Overlap / Crossfade); null for none. */
  setHandoff(time: number | null) {
    this.handoffAt = time
  }

  onHandoff(fn: () => void) {
    this.handoffListeners.add(fn)
    return () => {
      this.handoffListeners.delete(fn)
    }
  }

  /** Stops and lets go of the current song (e.g. it was deleted). */
  unload() {
    this.stopSources()
    this.playing = false
    this.pausedPos = 0
    this.loop = null
    this.pendingJump = null
    this.song = null
    this.dropSongChannels()
    for (const ch of this.channels.values()) ch.buffer = null
    this.emit()
  }

  private dropSongChannels() {
    for (const id of [...this.order]) {
      const ch = this.channels.get(id)!
      if (!ch.fromSong) continue
      ch.gain.disconnect()
      ch.panner.disconnect()
      this.channels.delete(id)
      this.order = this.order.filter((o) => o !== id)
    }
  }

  /** Whether the loaded song plays its own click stem instead of the generated click. */
  private get audioClick() {
    const id = this.song?.clickStem
    return !!id && this.channels.get(id)?.fromSong === true
  }

  /** Loads the current song again (after its click source changes), keeping the position and play state. */
  async reloadSong() {
    if (!this.song) return
    const pos = this.position
    const wasPlaying = this.playing
    this.load(this.song)
    this.pausedPos = Math.min(pos, this.song.duration)
    this.emit()
    if (wasPlaying) await this.play()
  }

  /** Re-renders the click after tempo / meter / offset changes. */
  regenerateClick() {
    if (!this.song) return
    // With the song's own click stem playing, the generated click stays silent.
    const bufs = this.audioClick ? null : renderClick(this.ctx, this.song)
    this.channels.get('accent')!.buffer = bufs?.accent ?? null
    this.channels.get('q')!.buffer = bufs?.q ?? null
    this.channels.get('e')!.buffer = bufs?.e ?? null
    this.channels.get('s')!.buffer = bufs?.s ?? null
    if (this.playing) this.seek(this.position)
  }

  /** Call after mutating song.sections so an active loop follows its section. */
  sectionsChanged() {
    if (!this.song || !this.loop) return
    const idx = this.song.sections.findIndex((s) => s.id === this.loop!.sectionId)
    if (idx < 0) this.setLoop(null)
    else this.setLoop(this.loop.sectionId, this.loop.mode)
  }

  get currentSong() {
    return this.song
  }

  // --------------------------------------------------------------- transport

  get position(): number {
    if (!this.playing) return this.pausedPos
    const now = this.ctx.currentTime
    let base = { ctxTime: this.startCtxTime, offset: this.startOffset }
    if (now < this.startCtxTime && this.prevBase) base = this.prevBase
    let p = base.offset + Math.max(0, now - base.ctxTime)
    const l = this.loop
    if (l && base.offset < l.end && p >= l.end) {
      p = l.start + ((p - l.end) % (l.end - l.start))
    }
    return p
  }

  get isPlaying() {
    return this.playing
  }

  private startSources(offset: number, when: number) {
    const l = this.loop
    for (const ch of this.channels.values()) {
      if (!ch.buffer) continue
      const src = this.ctx.createBufferSource()
      src.buffer = ch.buffer
      if (l && offset < l.end) {
        src.loop = true
        src.loopStart = l.start
        src.loopEnd = l.end
      }
      src.connect(ch.input)
      src.start(when, Math.min(offset, ch.buffer.duration))
      this.sources.push(src)
      this.sourceChannel.set(src, ch)
    }
    this.startCtxTime = when
    this.startOffset = offset
    this.lastTickPos = null
  }

  private stopSources(when?: number) {
    for (const s of this.sources) {
      try {
        s.stop(when)
      } catch {
        /* already stopped */
      }
    }
    if (when === undefined) {
      for (const s of this.sources) s.disconnect()
      this.sources = []
    } else {
      const old = this.sources
      this.sources = []
      window.setTimeout(() => old.forEach((s) => s.disconnect()), (when - this.ctx.currentTime) * 1000 + 200)
    }
  }

  async play() {
    if (!this.song || this.playing) return
    if (this.ctx.state !== 'running') await this.ctx.resume()
    if (this.fading !== 'in') this.cancelFade()
    if (this.pausedPos >= this.song.duration - 0.05) this.pausedPos = 0
    this.startSources(this.pausedPos, this.ctx.currentTime + 0.04)
    this.prevBase = null
    this.playing = true
    this.sendMidi([this.pausedPos === 0 ? 0xfa : 0xfb])
    this.emit()
  }

  pause() {
    if (!this.playing) return
    this.pausedPos = this.position
    this.stopSources()
    this.playing = false
    this.pendingJump = null
    this.cancelFade()
    this.sendMidi([0xfc])
    this.emit()
  }

  toggle() {
    if (this.playing) this.pause()
    else void this.play()
  }

  seek(time: number) {
    if (!this.song) return
    time = Math.max(0, Math.min(time, this.song.duration))
    if (this.loop && (time < this.loop.start || time >= this.loop.end)) this.loop = null
    this.pendingJump = null
    if (this.playing) {
      this.stopSources()
      this.startSources(time, this.ctx.currentTime + 0.03)
      this.prevBase = null
    } else {
      this.pausedPos = time
      this.lastTickPos = null
    }
    this.emit()
  }

  /** Jump to a section. While playing, the jump is quantised according to `mode`. */
  jumpToSection(sectionId: string, mode: JumpMode) {
    const song = this.song
    if (!song) return
    const idx = song.sections.findIndex((s) => s.id === sectionId)
    if (idx < 0) return
    const target = song.sections[idx].start
    if (!this.playing || mode === 'immediate') {
      this.seek(target)
      return
    }
    if (this.pendingJump) {
      // Re-target a jump that hasn't landed yet: keep its landing time.
      const when = this.pendingJump.when
      this.stopSources()
      this.startSources(target, when)
      this.pendingJump = { sectionId, when }
      this.emit()
      return
    }
    const pos = this.position
    let landAt: number
    if (mode === 'bar') {
      const bar = barLength(song)
      const rel = pos - song.clickOffset
      landAt = song.clickOffset + Math.ceil((rel + 0.02) / bar) * bar
    } else {
      const cur = song.sections.findIndex((_, i) => sectionEnd(song, i) > pos)
      landAt = this.loop ? this.loop.end : sectionEnd(song, Math.max(0, cur))
    }
    const when = this.ctx.currentTime + Math.max(0.03, landAt - pos)
    if (this.loop && this.loop.sectionId !== sectionId) {
      // Let the current pass of the loop finish, then leave it.
      for (const s of this.sources) s.loop = false
      this.rebase()
      this.loop = null
    }
    this.prevBase = { ctxTime: this.startCtxTime, offset: this.startOffset }
    this.stopSources(when)
    this.startSources(target, when)
    this.pendingJump = { sectionId, when }
    this.emit()
  }

  /** Re-anchors the position calculation at "now" so live loop changes stay consistent. */
  private rebase() {
    if (!this.playing) return
    const pos = this.position
    this.startOffset = pos
    this.startCtxTime = this.ctx.currentTime
    this.prevBase = null
  }

  setLoop(sectionId: string | null, mode: LoopMode = 'forever') {
    const song = this.song
    if (!song) return
    this.rebase()
    if (sectionId === null) {
      this.loop = null
      for (const s of this.sources) s.loop = false
    } else {
      const idx = song.sections.findIndex((s) => s.id === sectionId)
      if (idx < 0) return
      const start = song.sections[idx].start
      const end = sectionEnd(song, idx)
      this.loop = { sectionId, start, end, mode }
      const pos = this.position
      for (const s of this.sources) {
        if (pos < end) {
          s.loopStart = start
          s.loopEnd = end
          s.loop = true
        } else {
          s.loop = false
        }
      }
    }
    this.emit()
  }

  /** Turns this kind of loop on for the section, or off if it's already on. */
  toggleLoop(sectionId: string, mode: LoopMode = 'forever') {
    const l = this.loop
    this.setLoop(l?.sectionId === sectionId && l.mode === mode ? null : sectionId, mode)
  }

  /** A section's loop button: off → repeat once → repeat until turned off → off. */
  cycleLoop(sectionId: string) {
    const l = this.loop?.sectionId === sectionId ? this.loop : null
    if (!l) this.setLoop(sectionId, 'once')
    else if (l.mode === 'once') this.setLoop(sectionId, 'forever')
    else this.setLoop(null)
  }

  /** Ramps every output's fade stage from where it is now to `to` over `seconds`. */
  private rampFade(to: number, seconds: number, from?: number) {
    const now = this.ctx.currentTime
    for (const { fade } of this.outputs.values()) {
      fade.gain.cancelScheduledValues(now)
      fade.gain.setValueAtTime(from ?? fade.gain.value, now)
      fade.gain.linearRampToValueAtTime(to, now + seconds)
    }
  }

  fadeOut(seconds = this.fadeSeconds) {
    if (!this.playing || this.fading === 'out') return
    window.clearTimeout(this.fadeTimer)
    this.fading = 'out'
    this.rampFade(0, seconds)
    this.fadeTimer = window.setTimeout(() => {
      this.pause()
    }, seconds * 1000 + 50)
    this.emit()
  }

  /** Starts playback from silence and brings the tracks up over `seconds`. */
  async fadeIn(seconds = this.fadeSeconds) {
    if (!this.song || this.playing) return
    if (this.ctx.state !== 'running') await this.ctx.resume()
    window.clearTimeout(this.fadeTimer)
    this.fading = 'in'
    this.rampFade(1, seconds, 0)
    await this.play()
    this.fadeTimer = window.setTimeout(() => {
      this.fading = null
      this.emit()
    }, seconds * 1000)
  }

  /**
   * The Fade button: fades in from a stop, fades out while playing, and turns a fade-out
   * that's under way back up.
   */
  toggleFade(seconds = this.fadeSeconds) {
    if (!this.playing) return void this.fadeIn(seconds)
    if (this.fading !== 'out') return this.fadeOut(seconds)
    window.clearTimeout(this.fadeTimer)
    this.fading = 'in'
    this.rampFade(1, seconds / 2)
    this.fadeTimer = window.setTimeout(() => {
      this.fading = null
      this.emit()
    }, (seconds / 2) * 1000)
    this.emit()
  }

  private cancelFade() {
    window.clearTimeout(this.fadeTimer)
    const now = this.ctx.currentTime
    for (const { fade } of this.outputs.values()) {
      fade.gain.cancelScheduledValues(now)
      fade.gain.setValueAtTime(1, now)
    }
    this.fading = null
  }

  onEnded(fn: () => void) {
    this.endedListeners.add(fn)
    return () => {
      this.endedListeners.delete(fn)
    }
  }

  private tick() {
    if (!this.playing || !this.song) return
    if (this.pendingJump && this.ctx.currentTime >= this.pendingJump.when) {
      this.pendingJump = null
      this.prevBase = null
      this.lastTickPos = null
      this.emit()
    }
    // Repeat once: as soon as the loop has gone round, let playback carry on past its end.
    const l = this.loop
    if (l?.mode === 'once' && !this.pendingJump && this.startOffset < l.end) {
      const raw = this.startOffset + (this.ctx.currentTime - this.startCtxTime)
      if (raw >= l.end + 0.02) {
        const pos = this.position
        for (const s of this.sources) s.loop = false
        this.loop = null
        this.startOffset = pos
        this.startCtxTime = this.ctx.currentTime
        this.prevBase = null
        this.lastTickPos = null
        this.emit()
      }
    }
    // The hand-off point fires when playback runs across it, not when a seek or jump lands past it.
    const pos = this.position
    const last = this.lastTickPos
    this.lastTickPos = pos
    const h = this.handoffAt
    if (h !== null && !this.loop && last !== null && last < h && pos >= h && pos - last < 1.5) {
      this.handoffListeners.forEach((fn) => fn())
      return
    }
    if (!this.loop && this.position >= this.song.duration) {
      this.stopSources()
      this.playing = false
      this.pausedPos = this.song.duration
      this.cancelFade()
      this.sendMidi([0xfc])
      this.emit()
      this.endedListeners.forEach((fn) => fn())
    }
  }

  // -------------------------------------------------------------------- MIDI

  private async initMidi() {
    if (!('requestMIDIAccess' in navigator)) return
    try {
      const access = await navigator.requestMIDIAccess()
      const refresh = () => (this.midi = [...access.outputs.values()])
      refresh()
      access.onstatechange = refresh
    } catch {
      /* MIDI not permitted */
    }
  }

  get midiAvailable() {
    return this.midi.length > 0
  }

  sendMidi(bytes: number[]) {
    if (this.midiMuted) return
    for (const out of this.midi) out.send(bytes)
  }

  setMidiMuted(m: boolean) {
    this.midiMuted = m
    this.emit()
  }

  // ------------------------------------------------------------ subscription

  private groupList(): EngineState['groups'] {
    const out: EngineState['groups'] = []
    for (const id of this.order) {
      const c = this.channels.get(id)!
      if (!c.busGroup) continue
      let g = out.find((x) => x.name === c.busGroup)
      if (!g) out.push((g = { name: c.busGroup, settings: this.groups.get(c.busGroup)!, members: [] }))
      g.members.push(c.id)
    }
    return out
  }

  private buildState(): EngineState {
    return {
      playing: this.playing,
      loop: this.loop,
      pendingJump: this.pendingJump,
      fade: this.fading,
      masterVolume: this.masterVolume,
      outputCount: this.outputCount,
      outputDeviceId: this.outputDeviceId,
      audioClick: this.audioClick,
      channels: this.order.map((id) => {
        const c = this.channels.get(id)!
        return { id: c.id, name: c.name, group: c.group, busGroup: c.busGroup, settings: c.settings }
      }),
      groups: this.groupList(),
    }
  }

  private emit() {
    this.state = this.buildState()
    this.listeners.forEach((fn) => fn())
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getState = () => this.state

  dispose() {
    window.clearInterval(this.tickTimer)
    void this.ctx.close()
  }
}

export type { Bus }
