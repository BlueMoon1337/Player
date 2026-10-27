<img src="build/logo.svg" alt="Player logo" width="96">

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
- **Update button.** Player checks GitHub for new releases and installs signed updates itself (see [Updates](#updates)).
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

## Updates

The desktop app's **Update** button installs new versions of Player without building anything. It's at the top of **Settings** (⋮), and also in **Player ▸ Check for Updates…** on a Mac and **Help ▸ Check for Updates…** elsewhere.

1. The first time, it asks for a GitHub token, because the repository is private. Make a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to **Only select repositories ▸ Player** and **Contents: Read-only**, and paste it in. Player keeps it in a file in its settings folder, on this computer only.
2. Player looks for a newer release about 15 seconds after it starts, and every six hours. When there is one, the **Settings** button gets a yellow dot, and Settings says which version is ready.
3. Open the Update window to see what's new, then click **Install and Restart**. Player:
   1. downloads the new version
   2. checks its signature
   3. replaces itself:
      - **macOS:** swaps in the new `Player.app`
      - **Windows:** runs the new installer silently
      - **Linux:** replaces the AppImage
   4. starts again

   Your songs, setlist and settings are kept.

**Publishing a release.** The **Release** GitHub Actions workflow (`.github/workflows/release.yml`) builds Player for macOS (one app for Apple silicon and Intel), Windows and Linux:

1. Raise `version` in `package.json`. Player only offers a release newer than itself.
2. Push that to `main`. The workflow starts by itself when that version hasn't been released yet. Pushing a tag such as `v0.3.0`, or **Actions ▸ Release ▸ Run workflow** on GitHub, also starts it.
3. The workflow then:
   1. makes a draft release, whose notes are the commits since the last one
   2. builds and signs the three apps into it
   3. adds `latest.json`, which is what the Update button reads
   4. publishes the release

   A version that has been published can't be used again, so raise it for the next release.

**The signing key.** Updates are signed with an Ed25519 private key, kept as the repository secret `UPDATE_SIGNING_KEY` (**Settings ▸ Secrets and variables ▸ Actions**, the whole `-----BEGIN PRIVATE KEY-----` block). Its public half is `electron/update-key.pem`, and Player refuses any download that isn't signed with it. Keep a copy of the private key somewhere safe: without it, no new version can be published to apps that already have this public key. Until the secret exists, the workflow does nothing and explains why.

**First install, and unsigned apps.** Versions before 0.2.0 have no Update button, so install 0.2.0 or later by hand once from the release's files:

- **macOS:** the `.dmg`
- **Windows:** `Player-Setup-….exe`
- **Linux:** the `.AppImage`

The apps aren't signed with an Apple Developer ID or a Windows certificate (macOS builds are ad-hoc signed), so the first time you open one:

- **macOS:** right-click it and choose **Open**, or use **System Settings ▸ Privacy & Security ▸ Open Anyway**.
- **Windows:** in SmartScreen, choose **More info ▸ Run anyway**.

Updates installed by the Update button don't ask again. If the Update window says macOS is running Player from a temporary, read-only copy (App Translocation, which happens to apps downloaded with a browser):

1. Quit Player and make sure it's in Applications.
2. Run `xattr -dr com.apple.quarantine /Applications/Player.app` in Terminal once.
3. Open Player again.

To try updates against a stand-in for GitHub, set `PLAYER_UPDATE_API` to its address. Signatures are still checked.

## Notes / next steps

- Stems are decoded fully into memory, so a song with many long stems uses a lot of RAM. Only the current song is kept loaded. Streaming stems from disk would remove this limit.
- With **Link**, the next song loads from disk when the current one ends, so there's a short gap. Preloading the next song would remove it.
- The Guide stem in the demo songs plays cue chimes, not spoken cues.
