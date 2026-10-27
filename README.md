# Player

A multitrack backing-track player for live worship and band use, in the spirit of Playback. Player is a desktop app for macOS, Windows and Linux, built with Electron, React, TypeScript and the Web Audio API. The same UI also runs as a web page, but with fewer features.

## Desktop features

- **Song library on disk.** Imported stems are copied into `Documents/Player Library`. Each song gets its own folder holding its stems and a `song.json` with its settings and sections. The setlist order is saved in `library.json`. Edits save automatically, and stems load from disk when you select a song. Removing a song moves its folder to the system Trash.
- **Audio interface support.** In **Buses → Outputs**, choose the audio device. Every output the device exposes becomes routable: send any channel to Main 1/2, to another pair (Out 3/4, 5/6, …), or to a single output in mono. A typical setup sends click and guide to Out 3/4 for in-ears and tracks to Main for front-of-house, and there's a one-click preset for it. The chosen device is remembered and reconnected the next time it's plugged in.
- **Built for live use.**
  - The display stays awake while audio is playing.
  - Quitting while audio plays asks for confirmation first.
  - Playback keeps full timing when the window is in the background.
  - Only one copy of the app can run at a time.
  - The window size and position are remembered.
- **Native menus.** File ▸ Import Stems… (⌘/Ctrl+I), Transport, View (setlist, edit mode, outputs, pad, full screen) and Settings (⌘/Ctrl+,).

## Features (desktop and web)

- **Sample-synced stems.** Every stem and click channel is an `AudioBufferSourceNode` started at the same audio-clock time. Loops and jumps restart them all together, so they never drift.
- **Generated click.** Accent, 1/4, 1/8 and 1/16 channels are rendered from the song's BPM, time signature and click offset, then summed into a Click bus.
- **Section timeline.** A colour-coded waveform with section markers. Click a section to jump to it, either immediately, at the next bar, or at the end of the section. Each section has its own loop toggle, and you can click the waveform to seek.
- **Transport.** BPM, time signature, key, elapsed and total time, previous, play/pause, and a fade-out button whose length you can configure.
- **Mixer.** Faders with meters, mute and solo for each channel, and a master fader with a limiter. Levels are saved between sessions.
- **Side buttons.**
  - **Pad Player** is an ambient pad that keeps playing between songs and can follow the song's key.
  - **Mute MIDI** silences the MIDI messages the app sends (start, stop, continue, and a program change on each song change).
  - **Link** rolls into the next song when the current one ends.
- **WAV import.** Player has its own WAV reader, which runs in a background worker so large stems don't freeze the UI. It handles:
  - 8/16/24/32-bit PCM, 32/64-bit float, A-law and µ-law
  - WAVE_FORMAT_EXTENSIBLE files, RF64/BW64 files over 4 GB, and recorder files whose headers were never finalised
  - Metadata DAWs embed in exports: cue markers with labels become song sections, the `acid` chunk sets tempo and meter, and `LIST/INFO` sets the song title

  Other formats (MP3, AAC/M4A, FLAC, OGG, AIFF) use the built-in decoder. Files that can't be decoded are skipped, and the app says why.
- **Demo songs.** Three synthesized demo songs are included, so the app works without any setup.

The web version keeps imported songs in memory only. It can choose an output device only in browsers that support `AudioContext.setSinkId`.

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
npm run dev          # desktop app with hot reload
npm run dev:web      # web version at http://localhost:5173
npm run typecheck
npm run dist:mac     # or dist:win / dist:linux — installers go in release/
```

Set `PLAYER_LIBRARY_DIR` to use a different library folder, for example for testing.

## Installers

Pushing a version tag (`git tag v0.2.0 && git push --tags`) runs the **Desktop builds** GitHub Actions workflow, which builds:

- a universal macOS `.dmg`
- a Windows `.exe` installer
- a Linux `.AppImage`

You can also start it by hand from the repo's Actions tab. The installers are attached to the run as artifacts.

The builds are **unsigned**:

- **macOS:** the first time, right-click the app and choose **Open**, or allow it in System Settings ▸ Privacy & Security.
- **Windows:** SmartScreen shows a warning; choose **More info ▸ Run anyway**.

Signing needs an Apple Developer ID and a Windows code-signing certificate.

## Notes / next steps

- Stems are decoded fully into memory, so a song with many long stems uses a lot of RAM. Only the current song is kept loaded. Streaming stems from disk would remove this limit.
- With **Link**, the next song loads from disk when the current one ends, so there's a short gap. Preloading the next song would remove it.
- The Guide stem in the demo songs plays cue chimes, not spoken cues.
