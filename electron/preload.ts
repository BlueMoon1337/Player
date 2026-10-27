import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopAPI, MenuCommand } from '../src/platform/types'

const api: DesktopAPI = {
  platform: process.platform,
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    pickStems: () => ipcRenderer.invoke('library:pick'),
    createSong: (paths) => ipcRenderer.invoke('library:create', paths),
    saveSong: (record) => ipcRenderer.invoke('library:save', record),
    removeFiles: (songId, files) => ipcRenderer.invoke('library:remove-files', songId, files),
    deleteSong: (songId) => ipcRenderer.invoke('library:delete', songId),
    restoreSong: (songId) => ipcRenderer.invoke('library:restore', songId),
    saveState: (state) => ipcRenderer.invoke('library:save-state', state),
    reveal: (songId) => ipcRenderer.invoke('library:reveal', songId),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  setActive: (active) => ipcRenderer.send('app:active', active),
  setMenuState: (state) => ipcRenderer.send('app:menu-state', state),
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
  },
  onMenu: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, cmd: MenuCommand) => cb(cmd)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.removeListener('menu', listener)
    }
  },
}

contextBridge.exposeInMainWorld('playerDesktop', api)
