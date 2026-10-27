/**
 * Undo and redo for the library and setlists (as in Lumen): every change is a step with a name
 * ("Delete “Grace Song”"), ⌘Z / ⇧⌘Z walk back and forth, and a note says what happened.
 * Steps last until Player closes; a deleted song's files are kept until the next launch.
 */
import { useSyncExternalStore } from 'react'

export interface Step {
  label: string
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
  /**
   * Steps with the same key, recorded within a moment of each other (typing into one field),
   * join into one: undo goes back to before the first, redo forward to after the last.
   */
  mergeKey?: string
}

const MERGE_WINDOW_MS = 1500
let lastRecordedAt = 0

const LIMIT = 200
let done: Step[] = []
let undone: Step[] = []
/** `undoable`: the note is about a change that was just made (it gets an Undo button). */
let note: { text: string; seq: number; undoable?: boolean } | null = null
let busy = false
let noteSeq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())

export interface HistoryState {
  undoLabel: string | null
  redoLabel: string | null
  note: { text: string; seq: number; undoable?: boolean } | null
}

let snapshot: HistoryState = { undoLabel: null, redoLabel: null, note: null }
function refresh() {
  snapshot = { undoLabel: done.at(-1)?.label ?? null, redoLabel: undone.at(-1)?.label ?? null, note }
  emit()
}

export function useHistory(): HistoryState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => snapshot,
  )
}

/** Records a change that has just been made. */
export function record(step: Step) {
  const last = done.at(-1)
  const now = Date.now()
  if (step.mergeKey && last?.mergeKey === step.mergeKey && !undone.length && now - lastRecordedAt < MERGE_WINDOW_MS) {
    last.redo = step.redo
    lastRecordedAt = now
    refresh()
    return
  }
  lastRecordedAt = now
  done.push(step)
  if (done.length > LIMIT) done.shift()
  undone = []
  refresh()
}

/** The undo key, as this computer writes it. */
export const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z'

/** Shows a note at the bottom of the window; an undoable one offers Undo. */
export function showNote(text: string, undoable = false) {
  note = { text, seq: ++noteSeq, undoable }
  refresh()
}

export function clearNote() {
  note = null
  refresh()
}

async function walk(from: Step[], to: Step[], dir: 'undo' | 'redo') {
  const step = from.at(-1)
  if (!step || busy) return
  busy = true
  try {
    await step[dir]()
    from.pop()
    to.push(step)
    note = { text: `${dir === 'undo' ? 'Undid' : 'Redid'} ${step.label}`, seq: ++noteSeq }
  } catch (e) {
    note = { text: `Couldn’t ${dir} ${step.label}: ${(e as Error).message}`, seq: ++noteSeq }
  } finally {
    busy = false
    refresh()
  }
}

export const undo = () => walk(done, undone, 'undo')
export const redo = () => walk(undone, done, 'redo')
