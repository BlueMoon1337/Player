# Player

A multitrack backing-track player for live worship and band use, in the spirit of Playback. Built as a web app (React + TypeScript + Vite + Web Audio API), so it can later be wrapped as a desktop app with Electron or Tauri.

## Features

- **Sample-synced stems.** Every stem and click channel is an `AudioBufferSourceNode` started at the same audio-clock time. Loops and jumps restart them all together, so they never drift.
- **Generated click.** Accent, 1/4, 1/8 and 1/16 channels are rendered from the song's BPM, time signature and click offset, then summed into a Click bus.
- **Section timeline.** A colour-coded waveform with section markers. Click a section to jump to it, either immediately, at the next bar, or at the end of the section (set this in the ⋮ menu). Each section has its own loop toggle, and you can click the waveform to seek.
- **Transport.** BPM, time signature, key, elapsed and total time, previous, play/pause, and a fade-out button whose length you can configure.
- **Mixer.** Faders with meters, mute and solo for each channel, and a master fader with a limiter. Levels are saved between sessions.
- **Side buttons.**
  - **Buses** pans channels hard left or right, for click-in-one-ear in-ear monitor splits.
  - **Pad Player** is an ambient pad that keeps playing between songs and can follow the song's key.
  - **Mute MIDI** silences the MIDI messages the app sends to Web MIDI outputs (start, stop, continue, and a program change on each song change).
  - **Link** rolls into the next song when the current one ends.
- **Setlist.** Song cards with artwork, key and tempo. In EDIT mode you can reorder or remove songs.
- **Bring your own stems.** Use **Import stems**, or drop audio files on the window. Each file becomes a channel. Then use EDIT to set the BPM, meter, key and click offset, and to add sections at the playhead. Files that can't be decoded are skipped, and the app says why, so the rest of the song still imports.
- **WAV import.** WAV is the recommended format. Player has its own WAV reader, so WAV files decode the same in every browser. It handles:
  - 8/16/24/32-bit PCM, 32/64-bit float, A-law and µ-law
  - WAVE_FORMAT_EXTENSIBLE files, RF64/BW64 files over 4 GB, and recorder files whose headers were never finalised
  - Metadata DAWs embed in exports: cue markers with labels become song sections, the `acid` chunk sets tempo and meter, and `LIST/INFO` sets the song title.

  Other formats (MP3, AAC/M4A, FLAC, OGG, AIFF) use the browser's decoder.
- **Demo songs.** Three synthesized demo songs (Guide, Drums, Perc, Bass, AG and EG 1 stems) are included, so the app works without any setup.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Previous (or back to start) / next song |
| 1–9 | Jump to section |
| L | Loop current section |
| F | Fade out |

## Development

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # type-check + production build
```

## Notes / next steps

- Imported songs live in memory only. Persisting them (for example with IndexedDB or the File System Access API) is the next step.
- Buses currently route to the left and right sides of the stereo output. A desktop wrapper could add true multi-output routing to an audio interface.
- The Guide stem in the demo songs plays cue chimes, not spoken cues.
