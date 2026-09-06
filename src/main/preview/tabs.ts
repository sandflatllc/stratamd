import { createHash } from 'node:crypto'
import type { PreviewTabView, PreviewViewportView } from '../../shared/contracts'

/**
 * The preview window's page instances as records (docs/plans/open/visual-review,
 * phase 2), kept apart from Electron so the routing rules can be tested on
 * their own: a request that names a tab goes there; one that names none goes
 * to the thread's current tab, the last one that thread opened; the owner's
 * active tab is never the fallback; a missing or closed tab is an error.
 */
export interface PreviewTabRecord extends PreviewTabView {
  workingFolder: string
  partition: string
}

/** What T3's broker reads from a refused request. */
export type PreviewFailureTag =
  | 'PreviewAutomationTabNotFoundError'
  | 'PreviewAutomationControlInterruptedError'
  | 'PreviewAutomationTimeoutError'
  | 'PreviewAutomationInvalidSelectorError'
  | 'PreviewAutomationTargetNotEditableError'
  | 'PreviewAutomationResultTooLargeError'
  | 'PreviewAutomationExecutionError'
  | 'PreviewAutomationUnsupportedClientError'

export class PreviewFailure extends Error {
  readonly tag: PreviewFailureTag
  readonly detail: unknown
  constructor(tag: PreviewFailureTag, message: string, detail?: unknown) {
    super(message)
    this.tag = tag
    this.detail = detail
  }
}

/** Browser storage is separate per project working folder and shared by its human and agent tabs. */
export function partitionFor(workingFolder: string): string {
  return `persist:strata-preview-${createHash('sha256').update(workingFolder).digest('hex').slice(0, 12)}`
}

export interface PersistedPreviewTab {
  id: string
  projectId: string
  workingFolder: string
  url: string
  title: string
  viewport: PreviewViewportView
  openedAt: number
}

export class PreviewTabModel {
  readonly #tabs = new Map<string, PreviewTabRecord>()
  /** The last tab each thread opened. */
  readonly #currentByThread = new Map<string, string>()

  get size(): number { return this.#tabs.size }

  list(): PreviewTabRecord[] {
    return [...this.#tabs.values()].sort((left, right) => left.openedAt - right.openedAt)
  }

  get(id: string): PreviewTabRecord | null {
    return this.#tabs.get(id) ?? null
  }

  add(record: PreviewTabRecord): void {
    this.#tabs.set(record.id, record)
    if (record.threadId) this.#currentByThread.set(record.threadId, record.id)
  }

  remove(id: string): PreviewTabRecord | null {
    const record = this.#tabs.get(id) ?? null
    if (!record) return null
    this.#tabs.delete(id)
    for (const [threadId, tabId] of [...this.#currentByThread]) if (tabId === id) this.#currentByThread.delete(threadId)
    return record
  }

  update(id: string, patch: Partial<PreviewTabRecord>): PreviewTabRecord | null {
    const record = this.#tabs.get(id)
    if (!record) return null
    const next = { ...record, ...patch }
    this.#tabs.set(id, next)
    return next
  }

  /** The thread's current tab: the last one it opened, when it is still open. */
  currentFor(threadId: string): PreviewTabRecord | null {
    const id = this.#currentByThread.get(threadId)
    return id ? this.#tabs.get(id) ?? null : null
  }

  setCurrent(threadId: string, tabId: string): void {
    if (this.#tabs.has(tabId)) this.#currentByThread.set(threadId, tabId)
  }

  /**
   * The tab a request acts on. A named tab must exist; an unnamed request
   * goes to the thread's current tab; the owner's active tab is never a
   * fallback.
   */
  resolve(threadId: string, tabId: string | undefined): PreviewTabRecord {
    if (tabId !== undefined) {
      const named = this.#tabs.get(tabId)
      if (!named) throw new PreviewFailure('PreviewAutomationTabNotFoundError', `Preview tab ${tabId} is closed or was never opened`)
      return named
    }
    const current = this.currentFor(threadId)
    if (!current) throw new PreviewFailure('PreviewAutomationTabNotFoundError', 'This thread has no preview tab yet. Open one first.')
    return current
  }

  tabsFor(projectId: string): PreviewTabRecord[] {
    return this.list().filter((tab) => tab.projectId === projectId)
  }

  /** Owner tabs survive a window closing and come back when one reopens; agent tabs belong to their run. */
  persisted(): PersistedPreviewTab[] {
    return this.list().filter((tab) => tab.kind === 'owner').map((tab) => ({ id: tab.id, projectId: tab.projectId, workingFolder: tab.workingFolder, url: tab.url, title: tab.title, viewport: tab.viewport, openedAt: tab.openedAt }))
  }
}
