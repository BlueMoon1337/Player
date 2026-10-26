import { barLength, renderClick } from './synth'
import {
  type Bus,
  type ChannelSettings,
  CLICK_CHANNELS,
  type Song,
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
}

interface Loop {
  sectionId: string
  start: number
  end: number
}

interface PendingJump {
  sectionId: string
  when: number
}

export interface EngineState {
  playing: boolean
  loop: Loop | null
  pendingJump: PendingJump | null
  fading: boolean
  channels: { id: string; name: string; group: 'click' | 'stem'; settings: ChannelSettings }[]
  masterVolume: number
}

const MIX_KEY = 'player.mix.v1'

const DEFAULT_SETTINGS: ChannelSettings = { volume: 0.75, mute: false, solo: false, bus: 'main' }

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

function loadMix(): Record<string, Partial<ChannelSettings>> {
  try {
    return JSON.parse(localStorage.getItem(MIX_KEY) || '{}')
  } catch {
    return {}
  }
}

export class Engine {
  readonly ctx: AudioContext
  private master: GainNode
  private fade: GainNode
  private clickBus!: Channel
  private channels = new Map<string, Channel>()
  private order: string[] = []
  private sources: AudioBufferSourceNode[] = []
  private song: Song | null = null

  private playing = false
  private startCtxTime = 0
  private startOffset = 0
  /** Timeline base in effect before a scheduled (quantised) jump lands. */
  private prevBase: { ctxTime: number; offset: number } | null = null
  private pausedPos = 0
  private loop: Loop | null = null
  private pendingJump: PendingJump | null = null
  private fading = false
  private fadeTimer: number | undefined
  private masterVolume = 0.75
  private listeners = new Set<() => void>()
  private endedListeners = new Set<() => void>()
  private state: EngineState
  private tickTimer: number
  private midi: MIDIOutput[] = []
  midiMuted = false
  fadeSeconds = 4

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    const limiter = this.ctx.createDynamicsCompressor()
    limiter.threshold.value = -1
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.1
    this.master = this.ctx.createGain()
    this.master.gain.value = faderToGain(this.masterVolume)
    this.fade = this.ctx.createGain()
    this.fade.connect(this.master).connect(limiter).connect(this.ctx.destination)

    const saved = loadMix()
    if (typeof saved.__master?.volume === 'number') {
      this.masterVolume = saved.__master.volume
      this.master.gain.value = faderToGain(this.masterVolume)
    }
    for (const c of CLICK_CHANNELS) {
      const ch = this.createChannel(c.id, c.name, 'click')
      if (c.id === 'click') this.clickBus = ch
    }
    this.state = this.buildState()
    this.tickTimer = window.setInterval(() => this.tick(), 30)
    this.initMidi()
  }

  // ---------------------------------------------------------------- channels

  private createChannel(id: string, name: string, group: 'click' | 'stem'): Channel {
    const saved = loadMix()[id] ?? {}
    const input = this.ctx.createGain()
    const gain = this.ctx.createGain()
    const panner = this.ctx.createStereoPanner()
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 512
    input.connect(gain).connect(panner)
    gain.connect(analyser)
    // Click sub-channels feed the Click bus; everything else feeds the fade stage.
    if (group === 'click' && id !== 'click') panner.connect(this.clickBus.input)
    else panner.connect(this.fade)
    const ch: Channel = {
      id,
      name,
      group,
      buffer: null,
      input,
      gain,
      panner,
      analyser,
      settings: { ...DEFAULT_SETTINGS, ...saved, solo: false },
    }
    this.channels.set(id, ch)
    this.order.push(id)
    return ch
  }

  private applyGains() {
    const anySolo = [...this.channels.values()].some((c) => c.group === 'stem' && c.settings.solo)
    const now = this.ctx.currentTime
    for (const ch of this.channels.values()) {
      const s = ch.settings
      let g = s.mute ? 0 : faderToGain(s.volume)
      if (ch.group === 'stem' && anySolo && !s.solo) g = 0
      ch.gain.gain.setTargetAtTime(g, now, 0.01)
      ch.panner.pan.setTargetAtTime(s.bus === 'left' ? -1 : s.bus === 'right' ? 1 : 0, now, 0.01)
    }
  }

  private saveMix() {
    const out: Record<string, Partial<ChannelSettings>> = loadMix()
    for (const ch of this.channels.values()) {
      out[ch.id] = { volume: ch.settings.volume, mute: ch.settings.mute, bus: ch.settings.bus }
    }
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
    this.applyGains()
    this.saveMix()
    this.emit()
  }

  setMasterVolume(v: number) {
    this.masterVolume = v
    this.master.gain.setTargetAtTime(faderToGain(v), this.ctx.currentTime, 0.01)
    this.saveMix()
    this.emit()
  }

  /** Peak level (0..1+) of a channel's post-fader signal, for metering. */
  meter(id: string): number {
    const ch = this.channels.get(id)
    if (!ch || !this.playing) return 0
    const data = new Float32Array(ch.analyser.fftSize)
    ch.analyser.getFloatTimeDomainData(data)
    let peak = 0
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
    return peak
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
    // Drop previous stem channels.
    for (const id of [...this.order]) {
      const ch = this.channels.get(id)!
      if (ch.group === 'stem') {
        ch.panner.disconnect()
        this.channels.delete(id)
        this.order = this.order.filter((o) => o !== id)
      }
    }
    for (const stem of song.stems) {
      const ch = this.createChannel(stem.id, stem.name, 'stem')
      ch.buffer = stem.buffer
    }
    this.regenerateClick()
    this.applyGains()
    this.emit()
  }

  /** Re-renders the click after tempo / meter / offset changes. */
  regenerateClick() {
    if (!this.song) return
    const bufs = renderClick(this.ctx, this.song)
    this.channels.get('accent')!.buffer = bufs.accent
    this.channels.get('q')!.buffer = bufs.q
    this.channels.get('e')!.buffer = bufs.e
    this.channels.get('s')!.buffer = bufs.s
    if (this.playing) this.seek(this.position)
  }

  /** Call after mutating song.sections so an active loop follows its section. */
  sectionsChanged() {
    if (!this.song || !this.loop) return
    const idx = this.song.sections.findIndex((s) => s.id === this.loop!.sectionId)
    if (idx < 0) this.setLoop(null)
    else this.setLoop(this.loop.sectionId)
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
    }
    this.startCtxTime = when
    this.startOffset = offset
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
    this.cancelFade()
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

  setLoop(sectionId: string | null) {
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
      this.loop = { sectionId, start, end }
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

  toggleLoop(sectionId: string) {
    this.setLoop(this.loop?.sectionId === sectionId ? null : sectionId)
  }

  fadeOut(seconds = this.fadeSeconds) {
    if (!this.playing || this.fading) return
    this.fading = true
    const now = this.ctx.currentTime
    this.fade.gain.cancelScheduledValues(now)
    this.fade.gain.setValueAtTime(this.fade.gain.value, now)
    this.fade.gain.linearRampToValueAtTime(0, now + seconds)
    this.fadeTimer = window.setTimeout(() => {
      this.pause()
    }, seconds * 1000 + 50)
    this.emit()
  }

  private cancelFade() {
    window.clearTimeout(this.fadeTimer)
    const now = this.ctx.currentTime
    this.fade.gain.cancelScheduledValues(now)
    this.fade.gain.setValueAtTime(1, now)
    if (this.fading) {
      this.fading = false
    }
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
      this.emit()
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

  private buildState(): EngineState {
    return {
      playing: this.playing,
      loop: this.loop,
      pendingJump: this.pendingJump,
      fading: this.fading,
      masterVolume: this.masterVolume,
      channels: this.order.map((id) => {
        const c = this.channels.get(id)!
        return { id: c.id, name: c.name, group: c.group, settings: c.settings }
      }),
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
