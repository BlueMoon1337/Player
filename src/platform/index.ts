import type { DesktopAPI } from './types'

/** The Electron bridge from the preload script, or null when running as a web page. */
export const desktop: DesktopAPI | null =
  (window as unknown as { playerDesktop?: DesktopAPI }).playerDesktop ?? null

export { mediaUrl } from './types'
export type { CreatedSong, DesktopAPI, LibraryData, MenuCommand, MenuState, SongRecord } from './types'
