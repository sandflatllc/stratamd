import { realpath } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

export interface SessionRecord {
  path: string
  name: string
  openedAt: number
  focusedAt: number
  dirty: boolean
  deleted: boolean
  pendingCount: number
}

export interface SessionRegistryOptions {
  canonicalize?: (path: string) => Promise<string>
  now?: () => number
  onChange?: (sessions: readonly SessionRecord[], focusedPath: string | null) => void
}

export type SessionOpenResult =
  | { kind: 'opened'; session: SessionRecord }
  | { kind: 'focused'; session: SessionRecord }

/**
 * Owns the app-shell parts of a document session: canonical identity, tab order,
 * focus, and close/rename bookkeeping. Document content remains in the state
 * service; this class deliberately has no renderer or Electron dependency.
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #canonicalize: (path: string) => Promise<string>
  readonly #now: () => number
  readonly #onChange?: SessionRegistryOptions['onChange']
  #focusedPath: string | null = null

  constructor(options: SessionRegistryOptions = {}) {
    this.#canonicalize = options.canonicalize ?? canonicalDocumentPath
    this.#now = options.now ?? Date.now
    this.#onChange = options.onChange
  }

  get focusedPath(): string | null {
    return this.#focusedPath
  }

  get size(): number {
    return this.#sessions.size
  }

  list(): SessionRecord[] {
    return [...this.#sessions.values()]
  }

  get(path: string): SessionRecord | undefined {
    return this.#sessions.get(path)
  }

  async open(path: string): Promise<SessionOpenResult> {
    const canonicalPath = await this.#canonicalize(path)
    const present = this.#sessions.get(canonicalPath)
    const focusedAt = this.#now()

    if (present) {
      present.focusedAt = focusedAt
      this.#focusedPath = canonicalPath
      this.#emit()
      return { kind: 'focused', session: present }
    }

    const session: SessionRecord = {
      path: canonicalPath,
      name: basename(canonicalPath),
      openedAt: focusedAt,
      focusedAt,
      dirty: false,
      deleted: false,
      pendingCount: 0
    }
    this.#sessions.set(canonicalPath, session)
    this.#focusedPath = canonicalPath
    this.#emit()
    return { kind: 'opened', session }
  }

  focus(path: string): boolean {
    const session = this.#sessions.get(path)
    if (!session) return false
    session.focusedAt = this.#now()
    this.#focusedPath = path
    this.#emit()
    return true
  }

  update(path: string, patch: Partial<Pick<SessionRecord, 'dirty' | 'deleted' | 'pendingCount'>>): void {
    const session = this.#sessions.get(path)
    if (!session) return
    Object.assign(session, patch)
    this.#emit()
  }

  close(path: string): boolean {
    if (!this.#sessions.delete(path)) return false
    if (this.#focusedPath === path) {
      this.#focusedPath = this.#mostRecentlyFocused()?.path ?? null
    }
    this.#emit()
    return true
  }

  async rename(from: string, to: string): Promise<SessionRecord | undefined> {
    const session = this.#sessions.get(from)
    if (!session) return undefined
    const canonicalTarget = await this.#canonicalize(to)
    const collision = this.#sessions.get(canonicalTarget)
    if (collision && collision !== session) {
      this.#sessions.delete(from)
      this.#focusedPath = canonicalTarget
      collision.focusedAt = this.#now()
      this.#emit()
      return collision
    }

    this.#sessions.delete(from)
    session.path = canonicalTarget
    session.name = basename(canonicalTarget)
    session.deleted = false
    this.#sessions.set(canonicalTarget, session)
    if (this.#focusedPath === from) this.#focusedPath = canonicalTarget
    this.#emit()
    return session
  }

  #mostRecentlyFocused(): SessionRecord | undefined {
    return this.list().sort((left, right) => right.focusedAt - left.focusedAt)[0]
  }

  #emit(): void {
    this.#onChange?.(this.list(), this.#focusedPath)
  }
}

export async function canonicalDocumentPath(path: string): Promise<string> {
  const absolutePath = resolve(path)
  if (!isMarkdownPath(absolutePath)) {
    throw new Error(`StrataMD only opens Markdown files: ${absolutePath}`)
  }
  return realpath(absolutePath)
}

export function isMarkdownPath(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

export function documentPathsFromArgv(argv: readonly string[], cwd = process.cwd()): string[] {
  const paths: string[] = []
  for (const argument of argv) {
    if (argument.startsWith('-')) continue
    try {
      const candidate = argument.startsWith('file://') ? decodeURIComponent(new URL(argument).pathname) : argument
      if (isMarkdownPath(candidate)) paths.push(resolve(cwd, candidate))
    } catch {
      // A malformed command-line URL is not a document launch request.
    }
  }
  return [...new Set(paths)]
}

export type AttachmentCallResult = 'active' | 'superseded'

interface ActiveAttachmentCall {
  generation: number
  supersede: () => void
}

/** Enforces the PRD rule that the later concurrent attach call wins. */
export class AttachmentCallRegistry {
  readonly #calls = new Map<string, ActiveAttachmentCall>()
  #generation = 0

  begin(agentId: string, onSuperseded: () => void): AttachmentCallLease {
    this.#calls.get(agentId)?.supersede()
    const generation = ++this.#generation
    this.#calls.set(agentId, { generation, supersede: onSuperseded })
    return {
      generation,
      isCurrent: () => this.#calls.get(agentId)?.generation === generation,
      finish: () => {
        if (this.#calls.get(agentId)?.generation === generation) this.#calls.delete(agentId)
      }
    }
  }

  cancel(agentId: string): boolean {
    const active = this.#calls.get(agentId)
    if (!active) return false
    this.#calls.delete(agentId)
    active.supersede()
    return true
  }
}

export interface AttachmentCallLease {
  generation: number
  isCurrent(): boolean
  finish(): void
}

export interface ExpirableAttachment {
  lastCallAt: number
  queuedDeliveries: readonly unknown[]
  waiting: boolean
}

export function attachmentShouldExpire(
  attachment: ExpirableAttachment,
  now: number,
  idleTimeoutMs = 24 * 60 * 60 * 1_000
): boolean {
  if (attachment.waiting || attachment.queuedDeliveries.length > 0) return false
  return now - attachment.lastCallAt >= idleTimeoutMs
}

export function attachmentState(attachment: Pick<ExpirableAttachment, 'waiting' | 'queuedDeliveries'>): 'waiting' | 'working' | 'pending' {
  if (attachment.waiting) return 'waiting'
  if (attachment.queuedDeliveries.length > 0) return 'pending'
  return 'working'
}
