import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type Rectangle,
  app,
  dialog,
  ipcMain,
  net,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
} from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { LibraryState, MenuCommand, MenuState, SongRecord } from '../src/platform/types'
import { Library, assertFileName, assertId } from './library'
import * as updates from './updates'
import { AUDIO_EXTENSIONS, importPaths } from './importer'
import { importPads } from './pads'
import { CUE_LANGUAGES, type CueLanguage, cleanPhrase, renderCues } from './cues'
import { type ExportFormat, exportApp, exportFile, exportFormats } from './selfExport'

/** Where spoken cues are kept: they're made by this computer's voices, so not in the library. */
const cuesRoot = () => path.join(app.getPath('userData'), 'cues')

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIR = path.join(__dirname, '..', 'dist')
const APP_ORIGIN = 'app://player'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.bwf': 'audio/wav',
  '.rf64': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "worker-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

let win: BrowserWindow | null = null
let library: Library
let active = false
let quitConfirmed = false
let sleepBlocker: number | null = null
let menuState: MenuState = { jumpMode: 'bar', setlistOpen: true, editMode: false, undoLabel: null, redoLabel: null }

function libraryRoot() {
  return process.env.PLAYER_LIBRARY_DIR || path.join(app.getPath('documents'), 'Player Library')
}

// ------------------------------------------------------------------ protocol

/**
 * Serves the built UI (app://player/...), library stems (app://player/media/<song>/<file>) and
 * imported pads (app://player/pads/<pad>/<file>).
 */
function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    if (url.host !== 'player') return new Response('Not found', { status: 404 })
    const headers: Record<string, string> = {}
    let file: string
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] === 'cues') {
      // Spoken cues made by cues.ts: app://player/cues/<language>/<file>.wav
      if (parts.length !== 3 || !(CUE_LANGUAGES as readonly string[]).includes(parts[1]) || !/^[0-9a-f]{20}\.wav$/.test(parts[2])) {
        return new Response('Forbidden', { status: 403 })
      }
      if (DEV_URL) headers['Access-Control-Allow-Origin'] = new URL(DEV_URL).origin
      return streamFile(path.join(cuesRoot(), parts[1], parts[2]), headers)
    }
    if (parts[0] === 'media' || parts[0] === 'pads') {
      try {
        if (parts.length !== 3) throw new Error('bad path')
        file = parts[0] === 'media' ? library.stemPath(parts[1], parts[2]) : library.padPath(parts[1], parts[2])
      } catch {
        return new Response('Forbidden', { status: 403 })
      }
      // The dev renderer runs on the Vite origin, so allow it to read stems.
      if (DEV_URL) headers['Access-Control-Allow-Origin'] = new URL(DEV_URL).origin
      return streamFile(file, headers)
    } else {
      file = path.resolve(RENDERER_DIR, '.' + path.posix.normalize('/' + parts.join('/')))
      if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      // Single-page app: anything that isn't a file gets index.html.
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(RENDERER_DIR, 'index.html')
      if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP
    }
    try {
      const res = await net.fetch(pathToFileURL(file).toString())
      if (!res.ok) return new Response('Not found', { status: 404 })
      headers['Content-Type'] = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(res.body, { status: 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/**
 * Streams a (large) stem straight from disk. Big chunks keep main-process overhead low:
 * this process also drives the window's frames, so per-chunk JS work shows up as UI stutter.
 */
async function streamFile(file: string, headers: Record<string, string>) {
  try {
    const { size } = await fsp.stat(file)
    const body = Readable.toWeb(fs.createReadStream(file, { highWaterMark: 4 << 20 })) as ReadableStream
    headers['Content-Type'] = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    headers['Content-Length'] = String(size)
    return new Response(body, { status: 200, headers })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

// ------------------------------------------------------------------- window

interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): WindowState {
  try {
    const s: WindowState = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
    // Ignore saved bounds that are no longer on any screen (e.g. an unplugged monitor).
    const b = s.bounds
    const visible =
      b &&
      screen.getAllDisplays().some(({ workArea: w }) => b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y)
    return visible ? s : { maximized: s.maximized }
  } catch {
    return {}
  }
}

function saveWindowState() {
  if (!win) return
  const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch {
    /* non-fatal */
  }
}

function createWindow() {
  const state = loadWindowState()
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...state.bounds,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0d0f13',
    title: 'Player',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep timers and the playhead running at full rate when the window is hidden.
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())
  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DEV_URL ?? APP_ORIGIN)) e.preventDefault()
  })

  win.on('close', (e) => {
    if (active && !quitConfirmed) {
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'warning',
        buttons: ['Keep Playing', 'Quit'],
        defaultId: 0,
        cancelId: 0,
        message: 'Audio is still playing',
        detail: 'Quitting now will stop playback.',
      })
      if (choice !== 1) {
        e.preventDefault()
        return
      }
      quitConfirmed = true
    }
    saveWindowState()
  })
  win.on('closed', () => {
    win = null
  })
}

function setActive(on: boolean) {
  active = on
  if (on && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-display-sleep')
  if (!on && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker)
    sleepBlocker = null
  }
}

// --------------------------------------------------------------------- menu

function send(cmd: MenuCommand) {
  win?.webContents.send('menu', cmd)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const sep = { type: 'separator' } as const
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => send('settings'),
  }
  const checkUpdates: MenuItemConstructorOptions = { label: 'Check for Updates…', click: () => send('check-updates') }
  const formatLabel: Record<ExportFormat, string> = { dmg: 'Disk Image (.dmg)…', zip: 'Zip Archive (.zip)…', appimage: 'AppImage…' }
  const formats = exportFormats()
  const exportPlayer: MenuItemConstructorOptions = formats.length
    ? { label: 'Export Player', submenu: formats.map((f) => ({ label: formatLabel[f], click: () => send(`export-app:${f}`) })) }
    : { label: 'Export Player (installed app only)', enabled: false }
  // Single-key shortcuts (Space, arrows, F, L, 1-9) are handled by the renderer so they
  // never fire while typing in a text field; the menu just names them.
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              checkUpdates,
              sep,
              settings,
              sep,
              { role: 'services' },
              sep,
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              sep,
              { role: 'quit' },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import Songs…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
        { label: 'Import Folder…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('import-folder') },
        sep,
        { label: 'Open Library Folder', click: () => void shell.openPath(library.root) },
        sep,
        exportPlayer,
        ...(isMac ? [] : [sep, settings, sep, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    {
      // Undo and Redo go to Player, which undoes typing in a text field and library changes
      // anywhere else (named after the step, as Lumen does).
      label: 'Edit',
      submenu: [
        {
          label: menuState.undoLabel ? `Undo ${menuState.undoLabel}` : 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => send('undo'),
        },
        {
          label: menuState.redoLabel ? `Redo ${menuState.redoLabel}` : 'Redo',
          accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
          click: () => send('redo'),
        },
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Transport',
      submenu: [
        { label: 'Play / Pause (Space)', click: () => send('toggle-play') },
        { label: 'Back / Previous Song (←)', click: () => send('prev') },
        { label: 'Next Song (→)', click: () => send('next') },
        { label: 'Fade In / Out (F)', click: () => send('fade') },
        { label: 'Loop Current Section (L)', click: () => send('loop') },
        sep,
        {
          label: 'Section Jumps',
          submenu: (
            [
              ['immediate', 'Immediately'],
              ['bar', 'At the Next Bar'],
              ['section', 'At the End of the Section'],
            ] as const
          ).map(([mode, label]) => ({
            label,
            type: 'radio' as const,
            checked: menuState.jumpMode === mode,
            click: () => send(`jump:${mode}`),
          })),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Setlist',
          type: 'checkbox',
          checked: menuState.setlistOpen,
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => send('toggle-setlist'),
        },
        {
          label: 'Edit Setlist / Song Map',
          type: 'checkbox',
          checked: menuState.editMode,
          accelerator: 'CmdOrCtrl+E',
          click: () => send('toggle-edit'),
        },
        { label: 'Setlists & Library…', accelerator: 'CmdOrCtrl+L', click: () => send('setlists') },
        { label: 'Song Settings…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('song-settings') },
        { label: 'Buses…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('outputs') },
        { label: 'Pad Player', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('pad') },
        sep,
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [sep, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]),
      ],
    },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ label: 'Help', submenu: [checkUpdates] }]),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------- ipc

/** Only our own UI may call into the main process. */
function trusted(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith(APP_ORIGIN + '/') || (!!DEV_URL && url.startsWith(DEV_URL))
}

function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Untrusted sender')
    return fn(...args)
  })
}

function registerIpc() {
  handle('library:load', () => library.load())

  handle('library:pick', async (kind: unknown) => {
    // macOS's panel can pick files and folders at once; elsewhere folders get their own dialog.
    const folders = kind === 'folders'
    const opts: Electron.OpenDialogOptions = {
      title: folders ? 'Import Song Folders' : 'Import Songs',
      buttonLabel: 'Import',
      properties: folders
        ? ['openDirectory', 'multiSelections']
        : ['openFile', 'multiSelections', ...(process.platform === 'darwin' ? (['openDirectory'] as const) : [])],
      filters: folders
        ? undefined
        : [
            { name: 'Songs (audio files, MultiTracks zips)', extensions: [...AUDIO_EXTENSIONS, 'zip'] },
            { name: 'All Files', extensions: ['*'] },
          ],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  handle('library:import', async (paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
      throw new Error('Expected absolute file paths')
    }
    return importPaths(library, paths, (p) => win?.webContents.send('library:import-progress', p))
  })

  handle('library:save', (rec: SongRecord) => library.saveSong(rec))

  handle('cues:render', async (lang: unknown, phrases: unknown) => {
    if (!(CUE_LANGUAGES as readonly unknown[]).includes(lang)) throw new Error('Unknown cue language')
    if (!Array.isArray(phrases) || phrases.length > 200) throw new Error('Expected a list of phrases')
    const list = [...new Set(phrases.map(cleanPhrase).filter((p): p is string => !!p))]
    return renderCues(cuesRoot(), lang as CueLanguage, list)
  })

  handle('pads:list', () => library.listPads())
  handle('pads:import', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Import Pads',
      buttonLabel: 'Import',
      message: 'Choose pad zips (each is one pad), or WAV files',
      properties: ['openFile', 'multiSelections', ...(process.platform === 'darwin' ? (['openDirectory'] as const) : [])],
      filters: [
        { name: 'Pads (zips of WAV files, or WAV files)', extensions: ['zip', 'wav', 'wave', 'aif', 'aiff'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return { pads: [], failed: [] }
    return importPads(library, r.filePaths)
  })
  handle('pads:delete', async (id: unknown) => {
    const dir = library.padDir(id as string)
    // To the system trash; where that isn't available (or doesn't answer), deleted outright.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000))
    try {
      await Promise.race([shell.trashItem(dir), timeout])
    } catch {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  handle('library:remove-files', (id: unknown, files: unknown) => {
    assertId(id)
    if (!Array.isArray(files)) throw new Error('Expected file names')
    files.forEach(assertFileName)
    return library.removeFiles(id, files)
  })

  handle('library:delete', (id: unknown) => {
    assertId(id)
    return library.deleteSong(id)
  })
  handle('library:restore', (id: unknown) => library.restoreSong(id as string))
  handle('library:save-state', (state: LibraryState) => library.saveState(state))
  handle('library:sizes', () => library.sizes())

  // Export Player: the file is chosen here, in a save dialog, and only that file is written.
  let lastExport: string | null = null
  handle('app:export-formats', () => exportFormats())
  handle('app:export', async (format: unknown) => {
    if (!win || !exportFormats().includes(format as ExportFormat)) throw new Error('Player can’t be exported in that format here.')
    const { name, filter } = exportFile(format as ExportFormat)
    const res = await dialog.showSaveDialog(win, {
      title: 'Export Player',
      defaultPath: path.join(app.getPath('desktop'), name),
      filters: [filter],
    })
    if (res.canceled || !res.filePath) return null
    const target = win
    target.setProgressBar(2) // indeterminate until there's a share to show
    try {
      await exportApp(format as ExportFormat, res.filePath, (done) => {
        if (target.isDestroyed()) return
        target.setProgressBar(done ?? 2)
        target.webContents.send('app:export-progress', done)
      })
    } finally {
      if (!target.isDestroyed()) target.setProgressBar(-1)
    }
    lastExport = res.filePath
    return { file: path.basename(res.filePath) }
  })
  handle('app:show-export', () => {
    if (lastExport) shell.showItemInFolder(lastExport)
  })

  handle('updates:info', () => ({ version: app.getVersion(), hasToken: updates.hasToken(), blocker: updates.blocker() }))
  handle('updates:set-token', (token: unknown) => updates.setToken(token))
  handle('updates:check', () => updates.check())
  handle('updates:install', () =>
    updates.install(win, () => {
      // Restarting into the new version isn't the kind of quit the "still playing?" guard is for.
      quitConfirmed = true
      setActive(false)
    }),
  )


  handle('library:reveal', async (id?: unknown) => {
    if (id === undefined) return void (await shell.openPath(library.root))
    assertId(id)
    await shell.openPath(library.songDir(id))
  })

  ipcMain.on('app:active', (e, on: unknown) => {
    if (trusted(e)) setActive(on === true)
  })

  ipcMain.on('app:menu-state', (e, s: Partial<MenuState>) => {
    if (!trusted(e) || typeof s !== 'object' || !s) return
    menuState = {
      jumpMode: s.jumpMode === 'immediate' || s.jumpMode === 'section' ? s.jumpMode : 'bar',
      setlistOpen: s.setlistOpen !== false,
      editMode: s.editMode === true,
      undoLabel: typeof s.undoLabel === 'string' ? s.undoLabel.slice(0, 80) : null,
      redoLabel: typeof s.redoLabel === 'string' ? s.redoLabel.slice(0, 80) : null,
    }
    buildMenu()
  })
}

// --------------------------------------------------------------- lifecycle

/** Songs deleted last session (kept so Undo could restore them) go to the system trash now. */
async function emptyLibraryTrash() {
  for (const dir of await library.trashedSongs()) {
    try {
      await shell.trashItem(dir)
    } catch {
      // No system trash (some Linux setups): delete it.
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function setupPermissions() {
  const ses = session.defaultSession
  // MIDI (start/stop out), output-device selection, and audio-only device access (to list
  // interfaces by name). Camera, location, notifications etc. are refused.
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      return cb(!types.includes('video'))
    }
    cb(permission === 'midi' || permission === 'speaker-selection')
  })
  ses.setPermissionCheckHandler((_wc, permission) =>
    permission === 'midi' || permission === 'media' || permission === 'speaker-selection',
  )
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app.whenReady().then(() => {
    library = new Library(libraryRoot())
    void emptyLibraryTrash()
    registerAppProtocol()
    setupPermissions()
    registerIpc()
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
