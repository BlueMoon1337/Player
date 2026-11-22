import { BUSES, type BusId, autoPanOutput, busOutput, trackBus } from './routing'
import { cuts, fadeOut, fullEnd, nextCut, pastCut, toHeard } from './arrangement'
import { freeMemory, isFoldedStereo } from './decoder'
import { barBefore, nextBar } from './grid'
import { type ClickSoundName, renderClick } from './synth'
import { type Bus, type ChannelSettings, CLICK_CHANNELS, type Song, busTopChannel, isReferenceName, parseBus, sectionEnd } from './types'

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
  /** The bus it goes to (stems only), by its name: Settings ▸ Tracks. */
  busGroup: BusId | null
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
  /** The limiter (limiter.worklet.js), or until it has loaded, the compressor chain below. */
  limiter: AudioNode
  /** What feeds the device channels: the limiter, or the end of the compressor chain. */
  tail: AudioNode
  splitter: ChannelSplitterNode | null
}

/** The lookahead limiter, run on the audio thread. */
const LIMITER_URL = new URL('./limiter.worklet.js', import.meta.url).href

const LIMIT_DB = -1
const LIMIT_RATIO = 20
/**
 * The make-up gain a DynamicsCompressorNode adds by itself (Web Audio: the reciprocal of its
 * curve's gain at 0 dBFS, to the power 0.6): +0.57 dB for this limiter, turning every song up
 * and pushing peaks over the top. It's taken back off after it.
 */
const LIMITER_MAKEUP = (10 ** (-(LIMIT_DB + -LIMIT_DB / LIMIT_RATIO) / 20)) ** 0.6

/*
 * Until the limiter worklet has loaded (or where AudioWorklet is missing), a compressor stands
 * in, followed by a soft ceiling for what its attack is too slow to catch.
 */

/** The ceiling's input is scaled by this, so its curve spans ±2 (+6 dBFS) of real level. */
const CEILING_RANGE = 2
/**
 * The ceiling: untouched up to -2 dBFS, then a smooth bend that never passes -0.2 dBFS, so a
 * peak the limiter misses is rounded off rather than clipped by the audio device (hard clipping
 * is what sounds crunchy, on every click).
 */
const CEILING_CURVE = (() => {
  const knee = 10 ** (-2 / 20)
  const top = 10 ** (-0.2 / 20)
  const n = 8193
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u = ((i / (n - 1)) * 2 - 1) * CEILING_RANGE
    const a = Math.abs(u)
    const y = a <= knee ? a : knee + (top - knee) * Math.tanh((a - knee) / (top - knee))
    curve[i] = Math.sign(u) * y
  }
  return curve
})()

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
  channels: {
    id: string
    name: string
    group: 'click' | 'stem'
    busGroup: BusId | null
    /** The output it plays out of (click and stems; the click's parts go with the click). */
    output: Bus | null
    /** The song's reference (original) recording. */
    reference: boolean
    settings: ChannelSettings
  }[]
  /** Spoken section cues are made for the loaded song. */
  cues: boolean
  /** Auto Pan is on: click and guide out 1 (left), tracks out 2 (right). */
  autoPan: boolean
  /** Settings ▸ MIDI Out. */
  midiOut: boolean
  /** The loaded song's buses (with their stems), in Playback's bus order; the Click bus is the click channel. */
  groups: { id: BusId; settings: GroupSettings; members: string[]; output: Bus }[]
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

const DEFAULT_SETTINGS: ChannelSettings = { volume: 0.75, mute: false, solo: false }
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
  /** The previous song's stems, still sounding under the next one after an Overlap / Crossfade. */
  private ringing: AudioBufferSourceNode[] = []
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
  /**
   * The section Fade Out applies: playback started before the fade's end. Started after it (to play
   * the sections after the fade), the song plays on to its real end, without the fade.
   */
  private fadeArmed = true
  /** The fade-out's ramp is scheduled on the tracks. */
  private fadeOutScheduled = false
  /** The song stopped at its end (or its fade's end): Play starts it from the top. */
  private atEnd = false
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
  private midiStarted = false
  private midiOut = false
  midiMuted = false
  fadeSeconds = 4
  // Settings ▸ General (set from the app's settings).
  private autoPan = false
  private clickSound: ClickSoundName = 'classic'
  private songBuses = false
  private songMaster = false
  private hideReference = false
  /** Settings ▸ Tracks and ▸ Buses: tracks routed to other buses, and the buses' outputs. */
  private trackBuses: Record<string, string> = {}
  private busOutputs: Record<string, string> = {}
  /** A song's channels start here when they have no saved level (Fader Default Level 80%). */
  private defaultVolume = 0.75
  /** Playing from the start of a section gives a bar of count-in with the tracks fading in. */
  sectionPreroll = false

  /** `ctx` is injectable so tests can render the graph offline with any channel count. */
  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' })
    this.ready = this.loadLimiter()
    this.padInput = this.ctx.createGain()
    const saved = loadMix()
    if (typeof saved.__master?.volume === 'number') this.masterVolume = saved.__master.volume
    this.configureOutputs()
    for (const c of CLICK_CHANNELS) {
      const ch = this.createChannel(c.id, c.name, 'click')
      if (c.id === 'click') this.clickBus = ch
    }
    this.routePad()
    this.state = this.buildState()
    this.tickTimer = window.setInterval(() => this.tick(), 30)
    this.ctx.addEventListener('sinkchange', () => {
      this.configureOutputs()
      this.emit()
    })
  }

  // ---------------------------------------------------------------- settings

  /** Auto Pan: click and guide out the left output (1), everything else out the right (2). */
  setAutoPan(on: boolean) {
    if (on === this.autoPan) return
    this.autoPan = on
    for (const ch of this.channels.values()) this.route(ch)
    this.routePad()
    this.emit()
  }

  /** Auto Pan holds on any device, as in Playback: Settings ▸ Buses routes once it's off. */
  private get autoPanning() {
    return this.autoPan
  }

  /**
   * Where the pad player plays: with the tracks (out the right while Auto Pan is splitting the
   * output, else Main), through the master fader and limiter.
   */
  readonly padInput: GainNode

  private routePad() {
    this.padInput.disconnect()
    // After the Fade stage: fading a song out leaves the pad playing.
    const bus = this.busRoute('pad')
    const out = this.output(bus)
    if (parseBus(bus).kind === 'mono') {
      // The master stage of a mono output isn't folded to one channel; fold the pad first.
      const mono = this.ctx.createGain()
      mono.channelCount = 1
      mono.channelCountMode = 'explicit'
      this.padInput.connect(mono).connect(out.master)
    } else {
      this.padInput.connect(out.master)
    }
  }

  setClickSound(sound: ClickSoundName) {
    if (sound === this.clickSound) return
    this.clickSound = sound
    this.regenerateClick()
  }

  /** The spoken cues for the loaded song (null: none). */
  setCues(buffer: AudioBuffer | null) {
    const ch = this.channels.get('cues')!
    if (ch.buffer === buffer) return
    ch.buffer = buffer
    if (this.playing) this.seek(this.position)
    this.emit()
  }

  /** Settings ▸ Tracks and ▸ Buses: which bus each track goes to, and each bus's output. */
  setRouting(trackBuses: Record<string, string>, busOutputs: Record<string, string>) {
    if (trackBuses === this.trackBuses && busOutputs === this.busOutputs) return
    this.trackBuses = trackBuses
    this.busOutputs = busOutputs
    for (const ch of this.channels.values()) if (ch.group === 'stem') ch.busGroup = trackBus(ch.name, trackBuses)
    this.reloadGroups()
    for (const ch of this.channels.values()) this.route(ch)
    this.routePad()
    this.emit()
  }

  /** Song Specific Buses: bus levels, mutes and solos kept per song rather than for all songs. */
  setSongSpecificBuses(on: boolean) {
    if (on === this.songBuses) return
    this.songBuses = on
    this.reloadGroups()
    this.emit()
  }

  /** Song Specific Master Fader: the master level kept per song. */
  setSongSpecificMaster(on: boolean) {
    if (on === this.songMaster) return
    this.songMaster = on
    this.reloadMaster()
    this.emit()
  }

  setReferenceVisible(on: boolean) {
    if (on === !this.hideReference) return
    this.hideReference = !on
    this.applyGains()
    this.emit()
  }

  /** Fader Default Level 80%: a song's faders start at 80% of the way to unity. */
  setFaderDefault80(on: boolean) {
    this.defaultVolume = on ? 0.6 : 0.75
  }

  /** MIDI Out: MIDI access is only asked for (and messages sent) while this is on. */
  setMidiOut(on: boolean) {
    this.midiOut = on
    if (on && !this.midiStarted) {
      this.midiStarted = true
      void this.initMidi().then(() => this.emit())
    }
    this.emit()
  }

  private groupKey(name: string) {
    return this.songBuses && this.song ? `${GROUP_PREFIX}${this.song.id}:${name}` : GROUP_PREFIX + name
  }

  private masterKey() {
    return this.songMaster && this.song ? `__master:${this.song.id}` : '__master'
  }

  /** Bus settings for the loaded song's buses, from where they're kept (per song or for all). */
  private reloadGroups() {
    this.groups.clear()
    const mix = loadMix()
    for (const ch of this.channels.values()) {
      if (!ch.busGroup || ch.busGroup === 'click' || this.groups.has(ch.busGroup)) continue
      const g = mix[this.groupKey(ch.busGroup)] ?? {}
      this.groups.set(ch.busGroup, { volume: g.volume ?? 0.75, mute: g.mute ?? false, solo: false })
    }
    this.applyGains()
  }

  private reloadMaster() {
    const mix = loadMix()
    const v = mix[this.masterKey()]?.volume ?? mix.__master?.volume
    this.masterVolume = typeof v === 'number' ? v : 0.75
    for (const out of this.outputs.values()) out.master.gain.setTargetAtTime(faderToGain(this.masterVolume), this.ctx.currentTime, 0.01)
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
    // Before the constructor has made the pad's input, there's nothing to route yet.
    if (this.padInput) this.routePad()
  }

  private connectOutput(bus: Bus, out: Output) {
    out.tail.disconnect()
    out.splitter?.disconnect()
    out.splitter = null
    if (busTopChannel(bus) >= this.outputCount) return
    const { kind, index } = parseBus(bus)
    if (kind === 'mono') {
      out.tail.connect(this.merger, 0, index)
    } else {
      out.splitter = this.ctx.createChannelSplitter(2)
      out.tail.connect(out.splitter)
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
    input.connect(fade).connect(master)
    const limiter = this.limiterNode(parseBus(bus).kind === 'mono' ? 1 : 2)
    let tail: AudioNode = limiter
    if (limiter instanceof DynamicsCompressorNode) {
      const trim = ctx.createGain()
      trim.gain.value = 1 / LIMITER_MAKEUP / CEILING_RANGE
      const ceiling = ctx.createWaveShaper()
      ceiling.curve = CEILING_CURVE
      limiter.connect(trim).connect(ceiling)
      tail = ceiling
    }
    master.connect(limiter)
    out = { input, fade, master, limiter, tail, splitter: null }
    this.outputs.set(bus, out)
    this.connectOutput(bus, out)
    return out
  }

  private limiterLoaded = false
  /** Resolves once the lookahead limiter is in every output (or can't be, and the compressor stays). */
  readonly ready: Promise<void>

  /** A limiter for an output of `channels` channels: the lookahead one once loaded, else a compressor. */
  private limiterNode(channels: number): AudioNode {
    if (this.limiterLoaded) {
      return new AudioWorkletNode(this.ctx, 'player-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: channels,
        channelCountMode: 'explicit',
        outputChannelCount: [channels],
        processorOptions: { ceiling: LIMIT_DB, lookahead: 0.0015, release: 0.08 },
      })
    }
    const c = this.ctx.createDynamicsCompressor()
    c.threshold.value = LIMIT_DB
    c.knee.value = 0
    c.ratio.value = LIMIT_RATIO
    c.attack.value = 0.002
    c.release.value = 0.1
    return c
  }

  /** Puts the lookahead limiter in place of the stand-in in every output made before it loaded. */
  private async loadLimiter() {
    try {
      await this.ctx.audioWorklet.addModule(LIMITER_URL)
    } catch {
      return // no AudioWorklet here: the compressor and ceiling stay
    }
    this.limiterLoaded = true
    for (const [bus, out] of this.outputs) {
      if (!(out.limiter instanceof DynamicsCompressorNode)) continue
      const limiter = this.limiterNode(parseBus(bus).kind === 'mono' ? 1 : 2)
      out.master.disconnect(out.limiter)
      out.tail.disconnect()
      out.master.connect(limiter)
      out.limiter = limiter
      out.tail = limiter
      this.connectOutput(bus, out)
    }
  }

  /** Falls back to Main when a route needs more outputs than the device has. */
  private effectiveBus(bus: Bus): Bus {
    return busTopChannel(bus) < this.outputCount ? bus : 'main'
  }

  /** Where a bus plays out: as Auto Pan splits it, else its output in Settings ▸ Buses. */
  private busRoute(id: BusId): Bus {
    return this.autoPanning ? autoPanOutput(id) : this.effectiveBus(busOutput(id, this.busOutputs))
  }

  /** The output a channel plays out of; the click's parts go through the Click channel. */
  private channelOutput(ch: Channel): Bus | null {
    if (ch.group === 'click' && ch.id !== 'click') return null
    return this.busRoute(ch.id === 'click' ? 'click' : (ch.busGroup ?? 'aux'))
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
    const bus = this.channelOutput(ch)!
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
      settings: {
        ...DEFAULT_SETTINGS,
        volume: fromSong ? this.defaultVolume : DEFAULT_SETTINGS.volume,
        // A song's original mix (a KeyFinder export's Reference) would double the stems: it starts muted.
        mute: group === 'stem' && isReferenceName(name),
        ...saved,
        solo: false,
      },
      fromSong,
      busGroup: group === 'stem' ? trackBus(name, this.trackBuses) : null,
    }
    if (ch.busGroup && ch.busGroup !== 'click' && !this.groups.has(ch.busGroup)) {
      const g = loadMix()[this.groupKey(ch.busGroup)] ?? {}
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
    // A track on the Click bus (a reference, say) is mixed by the Click strip, like the click itself.
    const onClickBus = (c: Channel) => c.group === 'stem' && c.busGroup === 'click'
    const grp = (c: Channel): GroupSettings | undefined =>
      onClickBus(c) ? this.clickBus?.settings : c.busGroup ? this.groups.get(c.busGroup) : undefined
    const stemSolo = all.some((c) => c.group === 'stem' && (c.settings.solo || (!onClickBus(c) && grp(c)?.solo)))
    const clickSolo = this.channels.get('click')?.settings.solo ?? false
    const partSolo = all.some((c) => c.group === 'click' && c.id !== 'click' && c.settings.solo)
    const now = this.ctx.currentTime
    for (const ch of all) {
      const s = ch.settings
      const g = grp(ch)
      let on = !s.mute && !g?.mute && !(this.hideReference && ch.group === 'stem' && isReferenceName(ch.name))
      if (onClickBus(ch)) on &&= !stemSolo || s.solo || clickSolo
      else if (ch.group === 'stem') on &&= stemSolo ? s.solo || !!g?.solo : !clickSolo
      else if (ch.id !== 'click') on &&= !partSolo || s.solo
      const gain = on ? faderToGain(s.volume) * (g ? faderToGain(g.volume) : 1) : 0
      ch.gain.gain.setTargetAtTime(gain, now, 0.01)
    }
  }

  private saveMix() {
    const out: Record<string, Partial<ChannelSettings>> = loadMix()
    for (const ch of this.channels.values()) {
      out[ch.id] = { volume: ch.settings.volume, mute: ch.settings.mute }
    }
    for (const [name, g] of this.groups) out[this.groupKey(name)] = { volume: g.volume, mute: g.mute }
    out[this.masterKey()] = { volume: this.masterVolume }
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
    this.applyGains()
    this.saveMix()
    this.emit()
  }

  /**
   * Puts the faders back at their default level, mutes left as they are: the loaded song's tracks
   * and the click's ('tracks', the Mixer), or the buses and the Click bus ('buses').
   */
  resetVolumes(which: 'tracks' | 'buses') {
    if (which === 'tracks') {
      for (const ch of this.channels.values()) {
        ch.settings = { ...ch.settings, volume: ch.fromSong && ch.group === 'stem' ? this.defaultVolume : DEFAULT_SETTINGS.volume }
      }
    } else {
      for (const [id, g] of this.groups) this.groups.set(id, { ...g, volume: DEFAULT_SETTINGS.volume })
      this.clickBus.settings = { ...this.clickBus.settings, volume: DEFAULT_SETTINGS.volume }
    }
    this.applyGains()
    this.saveMix()
    this.emit()
  }

  /** A bus in the Buses view: its fader, mute and solo apply on top of its stems' own. */
  setGroup(id: BusId, patch: Partial<GroupSettings>) {
    const g = this.groups.get(id)
    if (!g) return
    this.groups.set(id, { ...g, ...patch })
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
  groupMeter(id: BusId): number {
    if (!this.playing) return 0
    let peak = 0
    for (const ch of this.channels.values()) if (ch.busGroup === id) peak = Math.max(peak, peakOf(ch.analyser))
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
    this.transportRequest++
    this.stopSources()
    this.playing = false
    this.pausedPos = 0
    this.loop = null
    this.pendingJump = null
    this.song = song
    this.fadeArmed = true
    this.fadeOutScheduled = false
    this.atEnd = false
    this.dropSongChannels()
    // Bus settings and the master level may be kept per song; the cues are made for each song.
    this.groups.clear()
    this.channels.get('cues')!.buffer = null
    if (this.songMaster) this.reloadMaster()
    for (const stem of song.stems) {
      // A click stem (e.g. MultiTracks' Click Track) joins the click group and feeds the Click bus.
      const ch = this.createChannel(stem.id, stem.name, stem.id === song.clickStem ? 'click' : 'stem', true)
      ch.buffer = stem.buffer
      if (isFoldedStereo(stem.buffer)) {
        // Kept as one channel but stereo in the file: out of both sides at its full level, as
        // before (a mono input to the stereo panner would come out 3 dB down).
        ch.input.channelCount = 2
        ch.input.channelCountMode = 'explicit'
        ch.input.channelInterpretation = 'speakers'
      }
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

  /**
   * Takes the playing song's stems out of the mixer but leaves them sounding until the song ends as
   * arranged (or `fade` seconds from now): at its Fade Out's end, fading as it would have, or where
   * a cut at the end leaves off, not at the end of the audio.
   */
  private ringOut(fade: number | null) {
    const keep = this.sources.filter((s) => {
      const ch = this.sourceChannel.get(s)
      return ch?.fromSong && ch.group === 'stem'
    })
    if (!keep.length) return
    const song = this.song!
    // Up to the hand-off the song plays without cuts in its way (it's in the last section heard),
    // so heard time runs with the clock.
    const left = Math.max(0, toHeard(song, this.endOfSong()) - toHeard(song, this.position))
    const end = this.ctx.currentTime + (fade ? Math.min(fade, left) : left)
    if (!fade) this.scheduleFadeOut(true)
    this.sources = this.sources.filter((s) => !keep.includes(s))
    this.ringing.push(...keep)
    const chans = new Set(keep.map((s) => this.sourceChannel.get(s)!))
    for (const ch of chans) {
      this.channels.delete(ch.id)
      this.order = this.order.filter((o) => o !== ch.id)
    }
    const now = this.ctx.currentTime
    let count = keep.length
    for (const s of keep) {
      s.onended = () => {
        s.disconnect()
        this.ringing = this.ringing.filter((r) => r !== s)
        if (--count > 0) return
        for (const ch of chans) {
          ch.gain.disconnect()
          ch.panner.disconnect()
        }
      }
      try {
        s.loop = false
        s.stop(end)
      } catch {
        /* already over */
      }
    }
    if (fade) {
      for (const ch of chans) {
        ch.input.gain.setValueAtTime(ch.input.gain.value, now)
        ch.input.gain.linearRampToValueAtTime(0, now + fade)
      }
    }
  }

  /** Stop: the previous song's ring-out stops too (quickly faded, so it doesn't click). */
  private silenceRinging() {
    if (!this.ringing.length) return
    const now = this.ctx.currentTime
    for (const s of this.ringing) {
      const ch = this.sourceChannel.get(s)
      if (ch) {
        ch.input.gain.cancelScheduledValues(now)
        ch.input.gain.setValueAtTime(ch.input.gain.value, now)
        ch.input.gain.linearRampToValueAtTime(0, now + 0.03)
      }
      try {
        s.stop(now + 0.04)
      } catch {
        /* already over */
      }
    }
    this.ringing = []
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

  /** Undoes a pre-roll or crossfade fade-in that's still under way: the stems back at full level. */
  private resetStemFades() {
    this.fadeOutScheduled = false
    const now = this.ctx.currentTime
    for (const ch of this.channels.values()) {
      if (!ch.fromSong || ch.group !== 'stem') continue
      ch.input.gain.cancelScheduledValues(now)
      ch.input.gain.setValueAtTime(1, now)
    }
  }

  /** Stops and lets go of the current song (e.g. it was deleted). */
  unload() {
    this.silenceRinging()
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

  /**
   * Lets go of the loaded song's audio, to make room before another song is read: a long
   * MultiTracks song can take a few gigabytes, and two at once may not fit.
   */
  release() {
    this.transportRequest++
    this.silenceRinging()
    this.stopSources()
    this.playing = false
    this.loop = null
    this.pendingJump = null
    this.handoffAt = null
    this.dropSongChannels()
    for (const c of CLICK_CHANNELS) this.channels.get(c.id)!.buffer = null
    this.song = null
    this.emit()
    freeMemory()
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
    const bufs = this.audioClick ? null : renderClick(this.ctx, this.song, this.clickSound)
    this.channels.get('accent')!.buffer = bufs?.accent ?? null
    this.channels.get('q')!.buffer = bufs?.q ?? null
    this.channels.get('e')!.buffer = bufs?.e ?? null
    this.channels.get('s')!.buffer = bufs?.s ?? null
    if (this.playing) this.seek(this.position)
  }

  /** Call after mutating song.sections so an active loop follows its section. */
  sectionsChanged() {
    if (!this.song) return
    // A fade-out added, moved or changed: it applies from here on (one already behind the
    // playhead doesn't stop the song), and one under way follows the change.
    this.armFade(this.position)
    if (this.fadeOutScheduled) {
      this.clearFadeOut()
      if (this.playing) this.scheduleFadeOut()
    }
    if (!this.loop) return
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
    // Starting inside a cut section starts where its music picks up again.
    if (this.song) offset = pastCut(this.song, offset) ?? offset
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

  /**
   * Bumped by every play, pause and song load. A play that had to wait for the audio device to
   * wake up goes ahead only if nothing came after it: otherwise a Stop pressed meanwhile would be
   * undone, and two Plays would start the song twice, one copy beyond the reach of Stop.
   */
  private transportRequest = 0

  async play() {
    if (!this.song || this.playing) return
    const request = ++this.transportRequest
    if (this.ctx.state !== 'running') await this.ctx.resume()
    if (request !== this.transportRequest || !this.song || this.playing) return
    if (this.fading !== 'in') this.cancelFade()
    if (this.atEnd || this.pausedPos >= fullEnd(this.song) - 0.05) this.pausedPos = 0
    this.atEnd = false
    this.armFade(this.pausedPos)
    this.fadeOutScheduled = false
    // Song Section Pre-roll: from the start of a section, start a bar early, the click counting
    // in and the tracks fading up to full by the section's downbeat.
    let preroll = 0
    if (this.sectionPreroll && this.pausedPos > 0) {
      const sec = this.song.sections.find((s) => Math.abs(s.start - this.pausedPos) < 0.02)
      const from = sec ? barBefore(this.song, sec.start) : -1
      // Not when the bar before is cut: that music isn't heard before this section any more.
      const cutBefore = sec && cuts(this.song).some((c) => c.end > from + 1e-3 && c.start < sec.start - 1e-3)
      if (sec && from >= 0 && !cutBefore) {
        this.pausedPos = from
        preroll = sec.start - from
      }
    }
    const when = this.ctx.currentTime + 0.04
    this.startSources(this.pausedPos, when)
    if (preroll) {
      for (const ch of this.channels.values()) {
        if (!ch.fromSong || ch.group !== 'stem') continue
        ch.input.gain.cancelScheduledValues(when)
        ch.input.gain.setValueAtTime(0, when)
        ch.input.gain.linearRampToValueAtTime(1, when + preroll)
      }
    }
    this.prevBase = null
    this.playing = true
    this.sendMidi([this.pausedPos === 0 ? 0xfa : 0xfb])
    this.emit()
  }

  pause() {
    this.transportRequest++
    this.silenceRinging()
    if (!this.playing) return
    this.pausedPos = this.position
    this.stopSources()
    this.resetStemFades()
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
    time = pastCut(this.song, time) ?? time
    if (this.loop && (time < this.loop.start || time >= this.loop.end)) this.loop = null
    this.pendingJump = null
    this.atEnd = false
    this.armFade(time)
    if (this.playing) {
      this.stopSources()
      this.resetStemFades()
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
      this.clearFadeOut(when)
      this.pendingJump = { sectionId, when }
      this.emit()
      return
    }
    const pos = this.position
    let landAt: number
    if (mode === 'bar') {
      landAt = nextBar(song, pos + 0.02)
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
    // A fade-out under way stops where the jump lands; the fade comes again if the song reaches it.
    this.clearFadeOut(when)
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
      // While a loop holds playback, the fade waits: the tracks come back up.
      this.clearFadeOut()
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
    const request = ++this.transportRequest
    if (this.ctx.state !== 'running') await this.ctx.resume()
    if (request !== this.transportRequest || this.playing) return
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

  /** Where playback stops: the fade-out's end, while it applies, else where the music runs out. */
  private endOfSong(): number {
    const song = this.song!
    const f = this.fadeArmed ? fadeOut(song) : null
    return f ? Math.min(f.end, fullEnd(song)) : fullEnd(song)
  }

  /** Whether a fade-out applies to playback started (or landing) at `from`. */
  private armFade(from: number) {
    const f = this.song ? fadeOut(this.song) : null
    this.fadeArmed = !f || from < f.end - 0.05
  }

  /** Takes a scheduled fade-out off the tracks at `when` (now if not given): back to full level. */
  private clearFadeOut(when?: number) {
    if (!this.fadeOutScheduled) return
    this.fadeOutScheduled = false
    const at = when ?? this.ctx.currentTime
    for (const ch of this.channels.values()) {
      if (!ch.fromSong || ch.group !== 'stem') continue
      const g = ch.input.gain
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(at)
      else g.cancelScheduledValues(at)
      g.setValueAtTime(1, at)
    }
  }

  /**
   * Section Fade Out: as playback reaches the fade, the tracks ramp down to silence by its end (the
   * click and spoken cues keep going, to count the band out). Started inside the fade, they come in
   * at the level the fade has reached there. `ahead`: schedule it now, however far off it is (a
   * song ringing out under the next one, which this no longer ticks for).
   */
  private scheduleFadeOut(ahead = false) {
    const song = this.song!
    const f = fadeOut(song)
    if (!f || !this.fadeArmed || this.fadeOutScheduled || this.loop) return
    const now = this.ctx.currentTime
    // Before a scheduled start (a jump or a cut on its way), the position still runs on the old start.
    if (now < this.startCtxTime && !this.prevBase) return
    const at = toHeard(song, this.position)
    const start = toHeard(song, f.start)
    const end = toHeard(song, f.end)
    if ((!ahead && at < start - 0.3) || at >= end) return
    // Heard time runs with the clock (cuts are skipped without a gap).
    const t0 = now + Math.max(0, start - at)
    const t1 = now + (end - at)
    const g0 = at > start ? Math.max(0, Math.min(1, (end - at) / f.length)) : 1
    for (const ch of this.channels.values()) {
      if (!ch.fromSong || ch.group !== 'stem') continue
      const g = ch.input.gain
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t0)
      else g.cancelScheduledValues(t0)
      g.setValueAtTime(g0, t0)
      g.linearRampToValueAtTime(0, t1)
      // A jump on its way: the fade runs until it lands, and the tracks are back at full level there.
      const jump = this.pendingJump
      if (jump && jump.when < t1) {
        if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(jump.when)
        else g.cancelScheduledValues(jump.when)
        g.setValueAtTime(1, jump.when)
      }
    }
    this.fadeOutScheduled = true
  }

  private tick() {
    if (!this.playing || !this.song) return
    if (this.pendingJump && this.ctx.currentTime >= this.pendingJump.when) {
      this.pendingJump = null
      // Landed: the fade-out applies (again) if the song plays into it from here.
      this.fadeOutScheduled = false
      this.armFade(this.position)
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
    // A cut section coming up: carry on from the end of it at the same instant, as a section jump
    // does. (Not while a loop holds playback in its section, or a jump is landing.)
    if (!this.loop && !this.pendingJump && this.ctx.currentTime >= this.startCtxTime) {
      const at = this.position
      const cut = nextCut(this.song, at - 0.001)
      if (cut && cut.start - at < 0.25) {
        const when = Math.max(this.ctx.currentTime + 0.005, this.startCtxTime + (cut.start - this.startOffset))
        this.prevBase = { ctxTime: this.startCtxTime, offset: this.startOffset }
        this.stopSources(when)
        this.startSources(cut.end, when)
      }
    }
    // The hand-off point fires when playback runs across it, not when a seek or jump lands past it.
    const pos = this.position
    const last = this.lastTickPos
    this.lastTickPos = pos
    const h = this.handoffAt
    // Measured as heard: skipping a cut that ends at the hand-off point is still running across it.
    const heard = (t: number) => toHeard(this.song!, t)
    if (h !== null && !this.loop && last !== null && last < h && pos >= h && heard(pos) - heard(last) < 1.5) {
      this.handoffListeners.forEach((fn) => fn())
      return
    }
    this.scheduleFadeOut()
    if (!this.loop && !this.pendingJump && this.position >= this.endOfSong()) {
      const end = this.endOfSong()
      this.stopSources()
      this.resetStemFades()
      this.playing = false
      this.pausedPos = end
      this.atEnd = true
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
    return this.midiOut && this.midi.length > 0
  }

  sendMidi(bytes: number[]) {
    if (this.midiMuted || !this.midiOut) return
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
      if (!c.busGroup || c.busGroup === 'click') continue
      let g = out.find((x) => x.id === c.busGroup)
      if (!g) out.push((g = { id: c.busGroup, settings: this.groups.get(c.busGroup)!, members: [], output: this.busRoute(c.busGroup) }))
      g.members.push(c.id)
    }
    const rank = (id: BusId) => BUSES.findIndex((b) => b.id === id)
    return out.sort((a, b) => rank(a.id) - rank(b.id))
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
        return {
          id: c.id,
          name: c.name,
          group: c.group,
          busGroup: c.busGroup,
          output: this.channelOutput(c),
          reference: c.group === 'stem' && isReferenceName(c.name),
          settings: c.settings,
        }
      }),
      cues: !!this.channels.get('cues')?.buffer,
      autoPan: this.autoPanning,
      midiOut: this.midiOut,
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
