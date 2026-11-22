<img src="build/logo.svg" alt="Player logo" width="96">

# Player

A multitrack backing-track player for live worship and band use, in the spirit of Playback. Player is a desktop app for macOS, Windows and Linux, built with Electron, React, TypeScript and the Web Audio API. The same UI also runs as a web page, but with fewer features.

## Desktop features

- **Song library on disk.** Imported stems are copied into `Documents/Player Library`. Each song gets its own folder holding its stems and a `song.json` with its settings and sections. Setlists are saved in `library.json`. Edits save automatically, and stems load from disk when you select a song. A deleted song is kept until the next launch so it can be undone (see [Deleting and Undo](#deleting-and-undo)).
- **Console button.** A button above the Master fader that mutes and unmutes one channel, mix bus or DCA group on a Behringer or Midas X32 (an X32 Compact, say) on the local network, the way FaderLink talks to it.
  - **Setting it up.** Right-click the **Master** strip and choose **Console Button…**. Player looks for consoles on the network and lists the first one's channels, buses and DCAs by their scribble-strip names; choose one and click **Link**. Until a button is set up, Player doesn't look for consoles at all, so it sends nothing on a network that has none.
  - **Another console.** With a button set up, a second console that turns up on the network gets asked about once (never while audio is playing): **Choose…** moves the button to it, **Not Now** remembers it without a button.
  - **What the button shows.** It shows the strip's name, with a green dot when it's on and in red when it's muted. A change made at the console shows up on the button straight away. When the linked console isn't on the network, the button is greyed out. With nothing linked there's no button, and the Master strip looks as it always has.
  - **Remembered consoles.** Consoles are remembered (in `consoles.json` in Player's settings folder) with what each one's button mutes. They're found by name, so a new IP address doesn't matter. If two linked consoles are on the network at once, the button stays with the one it has.
  - **Changing the link.** Right-click the button or the Master strip to change what it mutes, remove the button, or forget a console.
  - **Network permission.** The first time, macOS asks to let Player find devices on the local network: click **Allow**. If the button stays greyed out, turn Player on in System Settings ▸ Privacy & Security ▸ Local Network.
- **Audio interface support.** In **Outputs**, choose the audio device. Every output the device exposes becomes routable: send any channel to Main 1/2, to another pair (Out 3/4, 5/6, …), or to a single output in mono. A typical setup sends click and guide to Out 3/4 for in-ears and tracks to Main for front-of-house, and there's a one-click preset for it. The chosen device is remembered and reconnected the next time it's plugged in.
- **Built for live use.**
  - The display stays awake while audio is playing.
  - Quitting while audio plays asks for confirmation first.
  - Playback keeps full timing when the window is in the background.
  - Only one copy of the app can run at a time.
  - The window size and position are remembered.
- **Update button.** Player checks GitHub for new releases and installs signed updates itself, or installs an update package from a zip, and can go back to the version before (see [Updates](#updates)).
- **Export Player.** File ▸ Export Player (or Settings ▸ About) saves a copy of the installed app to take to another computer without going online: on a Mac a disk image (Player.app with an Applications shortcut, made with `hdiutil`) or a zip (made with `ditto`, keeping the app's links, permissions and signature); on Windows a zip of the installed Player folder, to unzip anywhere and run `Player.exe`; on Linux the AppImage itself or a zip of it. Songs aren't included: they stay in the library folder.
- **Native menus.** File ▸ Import Stems… (⌘/Ctrl+I), Edit (Undo and Redo, named after the step), Transport, View (Setlists & Library ⌘/Ctrl+L, setlist row, edit mode, outputs, pad, full screen) and Settings (⌘/Ctrl+,).

## Features (desktop and web)

- **Sample-synced stems.** Every stem and click channel is an `AudioBufferSourceNode` started at the same audio-clock time. Loops and jumps restart them all together, so they never drift.
- **Generated click.** Accent, 1/4, 1/8 and 1/16 channels are rendered from the song's BPM, time signature and click offset, then summed into a Click bus.
- **Section timeline.** A colour-coded waveform with section markers, at Playback's scale: about a minute of the song across the window, scrolled sideways (wheel, trackpad or scrollbar) and following the playhead while it plays. Click a section to jump to it, either immediately, at the next bar, or at the end of the section. Each section has its own loop toggle, and you can click the waveform to seek.
- **Transport Area**, laid out like Playback's. From left to right:
  - **Tempo and time signature** of the loaded song (blank when no song is loaded).
  - **Time display:** where the song is now, large, with its start / end points underneath.
  - **PAD**, which turns the ambient pad on and off.
  - **Back To Start**, **Play / Pause**, and **Fade**. Fade brings the tracks in from a stop, fades them out while playing, and turns a fade-out back up if pressed again. Its length is set in Settings.
  - **EDIT / DONE.** Click to turn on edit mode (Playback's **Setlist / Song Map**); press and hold (or right-click) for **Song Settings…** (title, artist, album, key, tempo, click).
  - **Setlists Menu**, then the **More Menu** (≡) for settings, updates and the library folder.

  The current setlist's name is shown above the buttons.
- **Edit mode (Setlist / Song Map).**
  - **Setlist:** big cards with **−** (out of the setlist), **•••** (load, Song Settings, move), and **+** between cards to add a song there, or **Add a Song** at the end. Drag a card to move it to another place in the setlist; ⌘Z undoes the move.
  - **End of song:** the button at each card's corner says what happens when the song ends, as in Playback:
    - **Cue Next Song** (the default) loads the next song, ready to play. After the last song it's **Cue First Song**.
    - **Stay In Song** leaves the song loaded at its end.
    - **AutoLink** starts the next song straight away.
    - **Overlap** starts the next song when this one's last section begins, and lets that section play out underneath.
    - **Crossfade** does the same, but fades this song out (and the next one in) over the Fade length.
    - **Continue Pad** turns the pad on when the song ends, so there's no silence before the next one.

    With AutoLink, Overlap or Crossfade, the next song is loaded in the background while this one plays, so it starts without a gap.
  - **Library:** drag a song from the Library popover into the setlist, between any two cards. A **+** opens the Library beside it: **Songs**, **Albums** and **Artists**, each in alphabetical order, plus the most recently imported songs. Search covers titles, artists and albums. A song's page shows its key, tempo, length and sections, and adds it to the setlist at that spot.
  - **Song Map:** the sections over the waveform. Click a badge to jump there, or its loop button to loop it. **−** deletes a section, **+** adds one after it, and **•••** has the rest (rename, change type, move its start to the playhead). The **+** at the far left adds a section at the playhead. Everything can be undone. Section changes belong to the setlist they're made in: the same song in another setlist (and in the library) keeps its own sections from import.
  - **Fade Out:** a section's **•••** (or right-click) ▸ **Fade Out Here** makes the song fade out over the end of that section and stop there. The fade shows on the waveform as a slope with a handle; its label says how long the fade is (`-0:08.0`), and dragging it makes the fade longer or shorter (← and → on the handle change it by a second). The tracks fade, while the click and spoken cues keep going to count the band out. The sections after the fade stay on the timeline, dimmed; playing from one of them plays on to the real end. **Song Settings ▸ Sections** has the same, with the length in seconds. Like cuts, a fade belongs to the setlist it's made in.
- **Library and setlists.** Every song, imported or demo, lives in the library. Setlists are named, ordered lists of library songs, and the main window plays the current one. Open them with the Setlists Menu button:
  - **All Songs:** search the library (titles, artists and albums), and sort it by **Title**, **Artist** or **Key** (C, D♭, D…). **+ Add** opens a menu of your setlists (✓ where the song already is) and **New Setlist…**; double-clicking a song adds it to the current setlist. Drag a song onto any setlist at the side to add it there. Songs are deleted from the library only here; a setlist only removes them from itself.
  - **Deleting** a song, a setlist with songs in it, or an imported pad asks twice: what will go, then **Are you sure?**
  - **Setlists:** **+** makes one, and clicking one makes it current. Double-click a setlist to rename it, or right-click it to rename, duplicate or delete it.
  - **In a setlist:** drag songs to reorder them, or onto another setlist to add them there, and double-click a song to load it.
  - **Importing** adds the new song to the library and to the end of the current setlist.
- **Mixer (the lower part, as in Playback).** Each strip has **S** (solo) at the top, a meter beside the fader, and its name at the bottom: click the name to mute it (it greys out). The **›** beside the Click strip shows its parts (Accent, 1/4, 1/8, 1/16, or the song's Click Track). Right-click a strip to reset it or choose its output. The Master strip has left and right meters and a limiter. Levels are saved between sessions.
- **Side buttons.**
  - The **mixer** button shows the channel strips.
  - **Buses** groups the stems by name ("EG 1" and "EG 2" go under **EG**), with a fader, mute and solo for each bus. The **›** beside a bus shows its tracks. Right-click a bus to send all its tracks to one output.
  - **Pad Player** shows the pad: its fader, the pad sound, **IMPORT**, and the twelve keys. Click a key to play the pad in it; click the lit key to stop.
    - **IMPORT** brings in pads as zips of WAV files (each zip is one pad; WAV files chosen together work too). The key each WAV plays comes from its name, e.g. `Ambient Pad - Db.wav` or `Pad_F#.wav`. A key without its own file plays the nearest one, pitched. Each pass of the loop crossfades into the next, which starts a few seconds in, past the fade-in pads often have. On desktop, imported pads are kept in the library's `Pads` folder; in the web version they last for the session.
    - The **›** on the sound card chooses between the three built-in sounds and the imported pads, and deletes an imported pad. It also has two switches, both on to start with:
      - **Pad On When a Song Starts:** the pad comes on, in the song's key, the first time each song plays and whenever it plays from the top (not when resuming after a pause, so turning it off mid-song sticks).
      - **Follow Song Key:** choosing another song moves the pad to that song's key. A key picked by hand holds until the next song is chosen.
  - **Mute MIDI** silences the MIDI messages the app sends (start, stop, continue, and a program change on each song change). It turns red while on.
  - **Repeat once** (the partial loop) plays the section under the playhead one more time, then carries on.
  - **Repeat until turned off** (∞) loops that section until you turn it off.

  Each section on the timeline has the same loop button: click it once to repeat the section once, twice to repeat it until turned off, and a third time to stop. The keyboard does the same with **⇧L** and **L**.
- **Settings** (the ≡ button), laid out like Playback's, with **General**, **Outputs** and **About** tabs. General has:
  - **Auto Pan** (on by default, as in Playback): on a stereo output (headphones, the built-in speakers, a 2-output interface), the click, guide and cues go out the left and all tracks and the pad out the right, each mixed to mono. Connect it to the sound system with a 1/8" TRS to dual 1/4" TS cable and a stereo direct box (or two mono ones, or two line inputs): the left to the in-ears, the right to front of house. With a multi-output interface, each channel's routing in Outputs applies instead. The strips show L or R, and Outputs shows each channel's side.
  - **Click Sound:** Classic, Woodblock, Hi-Hat or Beep. A song's own Click Track is chosen in Song Settings ▸ Click.
  - **Guide Cue Language** (desktop app): spoken section cues a bar before each section, in English (female or male), Spanish, Portuguese or French, made with the computer's own voices (`say` on a Mac, the Windows speech voices, espeak-ng on Linux) and kept for next time. They play on the **Cues** strip in the click group. Off by default, as a MultiTracks Guide track already speaks them.
  - **Count Into Each Section:** the cue counts the rest of that bar: "Chorus, two, three, four".
  - **Song Section Pre-roll:** playing from the start of a section starts a bar early, the click counting in and the tracks fading up to the downbeat.
  - **Song Specific Buses** and **Song Specific Master Fader:** bus levels (with mute and solo) and the master level kept per song instead of for all songs.
  - **Reference Track:** shows a song's original mix (a track named Reference or Original); off hides and silences it.
  - **Default Ambient Pad:** the pad for songs that don't choose their own in Song Settings ▸ Pad.
  - **Audio Device**, **Waveform Grid** (bar and beat lines, and section edits snapping to bars), **Metronome Style VU** (the click meters flash on the beat), **Fader Default Level 80%** (a new song's faders start at 80% of the way to unity, about −4.7 dB), **Power Saver** (no meters; the playhead and scrolling update ten times a second), **MIDI Out**, and **Start Pad Player with Songs**.
  - Also Section Jumps, Fade Length and **AutoLink Every Song** (songs set to Cue Next Song start the next one straight away).
- **Outputs** (Settings ▸ Outputs, View ▸ Outputs…, or a strip's right-click menu) chooses the audio device and each channel's output.
- **Importing songs.** Use **Import songs**, **File ▸ Import Songs…** (⌘/Ctrl+I) or **Import Folder…** (⇧⌘/Ctrl+Shift+I), or drop files on the window. You can import several at once:
  - **MultiTracks.com zips** (e.g. `Goodness of God-Victory-Ab-63.00bpm.zip`), and the folders they unzip to. Each becomes a song:
    - Title, album, key and BPM come from the name. Add the artist in Song Settings.
    - The stems are the WAVs in the `MultiTracks/` folder, and `Album.jpg` becomes the cover.
    - The song sections come from the Ableton set's locators (`MultiTrack.als`). Their times follow its tempo map, including tempo changes.
    - Ableton project files and the hidden `__MACOSX/._*` copies Macs add are left out.
  - **[KeyFinder](https://github.com/BlueMoon1337/key-finder) exports** (its **Stems for Player**, e.g. `Yo Venceré-Danilo Montero-Cm-156.00bpm.zip`) are laid out the same way, with the artist where MultiTracks put the album. Player recognizes them by the "KeyFinder" software tag in their WAVs, so the title, **artist**, key and BPM all come in. Their **Click Track** is on the song's own beats, and a song that changes key gets a section at each change.
  - **Large zips are fine.** They're read straight from disk, one stem at a time, and each stem is checked against the zip's CRC-32. A damaged file is skipped and the app says so; the rest of the song still imports.
  - **Any other folder** of stems becomes a song, and **loose audio files** dropped together become one song.
- **Click Track.** A song with a click stem (MultiTracks' **Click Track**) plays it as the click. It goes through the Click fader and the Click bus's output routing (e.g. to the in-ear outputs), and the generated click stays silent. The song's own click follows its tempo changes, which a click generated from one BPM can't. Change it in **Song Settings ▸ Click** (Generated, or any stem); the change is undoable.
- **WAV decoding.** Player has its own WAV reader. It runs on several CPU cores at once, so a song's stems load in parallel and large stems don't freeze the UI. It handles:
  - 8/16/24/32-bit PCM, 32/64-bit float, A-law and µ-law
  - WAVE_FORMAT_EXTENSIBLE files, RF64/BW64 files over 4 GB, and recorder files whose headers were never finalised
  - Metadata DAWs embed in exports: cue markers with labels become song sections, the `acid` chunk sets tempo and meter, and `LIST/INFO` sets the song's title, artist and album

  Other formats (MP3, AAC/M4A, FLAC, OGG, AIFF) use the built-in decoder. Files that can't be decoded are skipped, and the app says why.
- **Demo songs.** Three synthesized demo songs are included, so the app works without any setup.

## Deleting and Undo

Deleting works as in Lumen. Everything can be deleted from its trash button, its right-click menu, or the **Delete** (⌫) key:

| What | How |
| --- | --- |
| A song in a setlist | Select it and press Delete, or click its **−**. It comes out of the setlist straight away, and stays in the library. |
| A song in the library | Select it and press Delete, or click its trash button. Player asks first, saying which setlists it comes out of and whether it's playing. If it is playing, playback stops. |
| A setlist | Its trash button, or right-click ▸ Delete Setlist…. A setlist with songs asks first (the songs stay in the library); an empty one goes straight away. |

Everything above can be undone, along with adding, moving, renaming and importing songs and setlists, and every song edit (title, key, tempo, time signature, click offset, sections):

- **⌘Z** (Ctrl+Z) undoes and **⇧⌘Z** (Ctrl+Shift+Z or Ctrl+Y) redoes, up to 200 steps until Player closes.
- A note at the bottom of the window says what was done or undone, with an **Undo** button after a deletion.
- Typing into one field (a title, a tempo, a section name) is one step, not one per key.
- In a text field, ⌘Z undoes the typing instead.
- A deleted song's files are kept in the library's hidden `.Trash` folder until Player next starts, so undo can bring them back. After that, they go to the system Trash.
- Player's questions are its own windows: Return answers yes and Escape answers no.

The web version keeps imported songs in memory only, and can import zips and audio files but not folders. It can choose an output device only in browsers that support `AudioContext.setSinkId`.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Previous (or back to start) / next song |
| 1–9 | Jump to section |
| L | Repeat the current section until turned off |
| ⇧L | Repeat the current section once |
| F | Fade in (from a stop) / out |
| ⌘Z / ⇧⌘Z | Undo / redo (Ctrl+Z / Ctrl+Y) |
| ⌘L | Setlists & library (desktop) |
| Delete | In the Setlists window: remove from setlist, or delete from library |

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

1. Updates come from the repository's `updates` branch (`latest.json` and a signed update package) and from its releases (whole apps); Player takes the newest. The repository is public, so no token is needed. If it's made private again, add a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to **Only select repositories ▸ Player** and **Contents: Read-only** under **Add a GitHub Token…** in the Update window; Player keeps it in a file in its settings folder, on this computer only, and sends it only to GitHub's API.
2. Player looks for a newer version about 15 seconds after it starts, and every six hours. When there is one, the **Settings** button gets a yellow dot, and Settings says which version is ready.
3. Open the Update window to see what's new, then click **Install and Restart**. Player:
   1. downloads the new version: an update package (everything but Electron, under 1 MB) when the release has one and it fits this copy, otherwise the whole app
   2. checks its signature
   3. keeps the version it replaces, for **Go Back**
   4. replaces itself:
      - **an update package:** swaps in the new `app.asar` (on a Mac it also records its fingerprint in `Info.plist` and signs the app again, ad hoc, as the release build does)
      - **macOS:** swaps in the new `Player.app`
      - **Windows:** runs the new installer silently
      - **Linux:** replaces the AppImage
   5. starts again, and says how it went

   Your songs, setlist and settings are kept.

**From a zip, and Go Back.** The Update window's **From a Zip** part installs a package without GitHub: **Install from Zip…** takes a `Player-<version>-update.zip` (or a release's Mac zip, or on Windows a zip holding the installer). It says whether the package is signed with Player's release key; an unsigned, older or same-version one installs only with **Install Anyway**. **Previous Version ▸ Go Back** puts back the version kept from before the last update (and keeps the one it leaves, so you can come back). An AppImage can't take packages; it's updated whole.

**Publishing a release without GitHub Actions** (the usual way: no build minutes):

```sh
npm version minor --no-git-tag-version        # or set "version" in package.json; commit and push it
UPDATE_SIGNING_KEY="$(cat update-key.private.pem)" npm run update-package   # → release/Player-<version>-update.zip
npm run publish-package                        # commits it to the updates branch and pushes it
```

`update-package` builds Player and packs everything but Electron (`dist/`, `dist-electron/`, `package.json`) into `app.asar`, with `player-update.json` (version, Electron version, SHA-512, signature), a README and `install-on-mac.sh`. `publish-package` puts the zip and `latest.json` on the `updates` branch (older zips stay in its history), where every copy of Player finds it within six hours, or at once with **Check Now**. The zip can also simply be sent and installed with **Install from Zip…**. `publish-package -- --release` makes a GitHub release through the API instead (needs `GITHUB_TOKEN` with **Contents: Read and write**). A package is refused by a copy of Player with a different major Electron version: then the whole app is needed.

Player 1.4.0 reads only releases, so it needs the 1.4.1 zip installed by hand once (Install from Zip…). Player 1.3.0 and earlier have no Install from Zip. On a Mac, unzip the package and run `bash ~/Downloads/Player-<version>-update/install-on-mac.sh` in Terminal once: it quits Player, keeps the installed version for Go Back, swaps in the new `app.asar`, updates `Info.plist`, signs the app again and opens it. On Windows, install the whole app once.

**Publishing whole apps** (when Electron or the packaging changes). The **Release** GitHub Actions workflow (`.github/workflows/release.yml`) builds Player for macOS (one app for Apple silicon and Intel), Windows and Linux. It runs only by hand, because it uses Actions minutes:

1. Raise `version` in `package.json` and push it. Player only offers a release newer than itself.
2. On GitHub, **Actions ▸ Release ▸ Run workflow**.
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

- Stems are decoded fully into memory, so a song with many long stems uses a lot of RAM: a typical 17-stem MultiTracks song needs about 1.5 GB. Only the current song is kept loaded. Streaming stems from disk would remove this limit.
- **Cue Next Song** loads the next song when the current one ends, which takes a moment for a large song. AutoLink, Overlap and Crossfade preload it.
- The Guide stem in the demo songs plays cue chimes, not spoken cues.
