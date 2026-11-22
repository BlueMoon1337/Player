import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ConsoleState, DesktopAPI, ImportProgress, LumenState, MenuCommand } from '../src/platform/types'

const api: DesktopAPI = {
  platform: process.platform,
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    pickImport: (kind) => ipcRenderer.invoke('library:pick', kind),
    importPaths: (paths) => ipcRenderer.invoke('library:import', paths),
    onImportProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: ImportProgress) => cb(p)
      ipcRenderer.on('library:import-progress', listener)
      return () => {
        ipcRenderer.removeListener('library:import-progress', listener)
      }
    },
    saveSong: (record) => ipcRenderer.invoke('library:save', record),
    removeFiles: (songId, files) => ipcRenderer.invoke('library:remove-files', songId, files),
    deleteSong: (songId) => ipcRenderer.invoke('library:delete', songId),
    restoreSong: (songId) => ipcRenderer.invoke('library:restore', songId),
    saveState: (state) => ipcRenderer.invoke('library:save-state', state),
    sizes: () => ipcRenderer.invoke('library:sizes'),
    reveal: (songId) => ipcRenderer.invoke('library:reveal', songId),
  },
  cues: {
    render: (lang, phrases) => ipcRenderer.invoke('cues:render', lang, phrases),
  },
  pads: {
    list: () => ipcRenderer.invoke('pads:list'),
    import: () => ipcRenderer.invoke('pads:import'),
    delete: (padId) => ipcRenderer.invoke('pads:delete', padId),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  setActive: (active) => ipcRenderer.send('app:active', active),
  setMenuState: (state) => ipcRenderer.send('app:menu-state', state),
  selfExport: {
    formats: () => ipcRenderer.invoke('app:export-formats'),
    save: (format) => ipcRenderer.invoke('app:export', format),
    show: () => ipcRenderer.invoke('app:show-export'),
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, done: number | null) => cb(done)
      ipcRenderer.on('app:export-progress', listener)
      return () => {
        ipcRenderer.removeListener('app:export-progress', listener)
      }
    },
  },
  updates: {
    info: () => ipcRenderer.invoke('updates:info'),
    setToken: (token) => ipcRenderer.invoke('updates:set-token', token),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: { received: number; total: number | null }) => cb(p)
      ipcRenderer.on('updates:progress', listener)
      return () => {
        ipcRenderer.removeListener('updates:progress', listener)
      }
    },
    pickPackage: () => ipcRenderer.invoke('updates:pick-package'),
    discardPackage: () => ipcRenderer.invoke('updates:discard-package'),
    installPackage: () => ipcRenderer.invoke('updates:install-package'),
    previous: () => ipcRenderer.invoke('updates:previous'),
    revert: () => ipcRenderer.invoke('updates:revert'),
    takeResult: () => ipcRenderer.invoke('updates:take-result'),
  },
  onFlush: (cb) => {
    const listener = () => {
      void Promise.resolve()
        .then(cb)
        .catch(() => {})
        .finally(() => ipcRenderer.send('app:flushed'))
    }
    ipcRenderer.on('app:flush', listener)
    return () => {
      ipcRenderer.removeListener('app:flush', listener)
    }
  },
  onMenu: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, cmd: MenuCommand) => cb(cmd)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.removeListener('menu', listener)
    }
  },
  console: {
    state: () => ipcRenderer.invoke('console:state'),
    onState: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, s: ConsoleState) => cb(s)
      ipcRenderer.on('console:state', listener)
      return () => {
        ipcRenderer.removeListener('console:state', listener)
      }
    },
    strips: (name) => ipcRenderer.invoke('console:strips', name),
    link: (name, target) => ipcRenderer.invoke('console:link', name, target),
    setMuted: (muted) => ipcRenderer.invoke('console:set-muted', muted),
    search: () => ipcRenderer.invoke('console:search'),
    forget: (name) => ipcRenderer.invoke('console:forget', name),
  },
  lumen: {
    state: () => ipcRenderer.invoke('lumen:state'),
    onState: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, s: LumenState) => cb(s)
      ipcRenderer.on('lumen:state', listener)
      return () => {
        ipcRenderer.removeListener('lumen:state', listener)
      }
    },
    setLooking: (on) => void ipcRenderer.invoke('lumen:set-looking', on),
    play: (what) => ipcRenderer.invoke('lumen:play', what),
  },
}

contextBridge.exposeInMainWorld('playerDesktop', api)
