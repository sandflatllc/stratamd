import type { AppView, DocumentView, EngineActivityView, EngineMessageView, EngineProjectView, EngineThreadView, EngineView } from './contracts'

/**
 * One engine-to-window state update. Either a complete view (`full`) or a
 * patch listing only the sections that changed since `base`. A patch never
 * guesses: the encoder diffs against the exact view it last sent, and the
 * window applies a patch only when `base` matches the seq it holds —
 * anything else triggers a full resync, so the worst case is one extra
 * full message, never a stale screen.
 */
export interface SyncedView {
  seq: number
  view: AppView
}

export interface ViewUpdate {
  seq: number
  full?: AppView
  base?: number
  sections?: {
    tabs?: AppView['tabs']
    explorer?: AppView['explorer']
    settings?: AppView['settings']
    /** The whole engine section; used when there is no base to diff against. */
    engine?: AppView['engine']
    /** The engine section as changes keyed by project, thread, and message id. */
    engineDelta?: EngineDelta
    preview?: AppView['preview']
    activeDocument?: ActiveDocumentSection | null
  }
  /** Present in verify mode: the complete view the merged result must equal. */
  verify?: AppView
}

export interface ContentSplice {
  /** Bytes kept from the start and end of the previous content. */
  prefix: number
  suffix: number
  insert: string
  /** Expected length of the spliced result; any mismatch forces a resync. */
  length: number
}

export interface ActiveDocumentSection {
  document: Omit<DocumentView, 'content'>
  content: { text: string } | { unchanged: true } | { splice: ContentSplice }
}

/**
 * An engine update that carries only what changed since the base view. Thread
 * bodies, messages, and activities travel when their JSON differs; everything
 * else is referenced by id, and the window reuses its previous objects for
 * those, so unchanged history keeps its identity through the renderer.
 */
export interface EngineDelta {
  engine: Omit<EngineView, 'projects'>
  projects: ProjectDelta[]
}

export interface ProjectDelta {
  id: string
  /** Absent when the project's own fields are unchanged since the base. */
  project?: Omit<EngineProjectView, 'threads'>
  threads: ThreadDelta[]
}

export interface ThreadDelta {
  id: string
  /** Absent when the thread's own fields are unchanged since the base. */
  thread?: Omit<EngineThreadView, 'messages' | 'activities'>
  /** Absent when the message list is unchanged since the base. */
  messages?: ListDelta<EngineMessageView>
  /** Absent when the activity list is unchanged since the base. */
  activities?: ListDelta<EngineActivityView>
}

export interface ListDelta<Item extends { id: string }> {
  /** The full order. */
  ids: string[]
  /** Items whose JSON differs from the base, or which are new. */
  changed: Item[]
}

type ThreadBody = Omit<EngineThreadView, 'messages' | 'activities'>
type ProjectBody = Omit<EngineProjectView, 'threads'>

function threadBody(thread: EngineThreadView): ThreadBody {
  const { messages: _messages, activities: _activities, ...body } = thread
  return body
}

function projectBody(project: EngineProjectView): ProjectBody {
  const { threads: _threads, ...body } = project
  return body
}

function byId<Item extends { id: string }>(items: readonly Item[]): Map<string, Item> {
  return new Map(items.map((item) => [item.id, item]))
}

function encodeList<Item extends { id: string }>(previous: readonly Item[] | undefined, next: readonly Item[]): ListDelta<Item> | undefined {
  if (previous === next) return undefined
  const previousById = previous ? byId(previous) : new Map<string, Item>()
  const changed: Item[] = []
  let sameOrder = previous !== undefined && previous.length === next.length
  next.forEach((item, index) => {
    const before = previousById.get(item.id)
    if (!before || !sameJson(before, item)) changed.push(item)
    if (sameOrder && previous![index]!.id !== item.id) sameOrder = false
  })
  if (sameOrder && changed.length === 0) return undefined
  return { ids: next.map((item) => item.id), changed }
}

export function encodeEngineDelta(previous: EngineView, next: EngineView): EngineDelta {
  const previousProjects = byId(previous.projects)
  const previousThreads = byId(previous.projects.flatMap((project) => project.threads))
  const { projects: _projects, ...engine } = next
  return {
    engine,
    projects: next.projects.map((project) => {
      const before = previousProjects.get(project.id)
      const body = projectBody(project)
      return {
        id: project.id,
        ...(before && sameJson(projectBody(before), body) ? {} : { project: body }),
        threads: project.threads.map((thread) => {
          const previousThread = previousThreads.get(thread.id)
          const delta: ThreadDelta = { id: thread.id }
          const nextBody = threadBody(thread)
          if (!previousThread || !sameJson(threadBody(previousThread), nextBody)) delta.thread = nextBody
          const messages = encodeList(previousThread?.messages, thread.messages)
          if (messages) delta.messages = messages
          const activities = encodeList(previousThread?.activities, thread.activities)
          if (activities) delta.activities = activities
          return delta
        }),
      }
    }),
  }
}

function applyList<Item extends { id: string }>(previous: readonly Item[] | undefined, delta: ListDelta<Item> | undefined): Item[] | null {
  if (!delta) return previous ? [...previous] : null
  const previousById = previous ? byId(previous) : new Map<string, Item>()
  const changedById = byId(delta.changed)
  const items: Item[] = []
  for (const id of delta.ids) {
    const item = changedById.get(id) ?? previousById.get(id)
    if (!item) return null
    items.push(item)
  }
  return items
}

/** Rebuilds the engine section, reusing every previous object the delta did not replace; null when the base does not hold what it references. */
export function applyEngineDelta(previous: EngineView, delta: EngineDelta): EngineView | null {
  const previousProjects = byId(previous.projects)
  const previousThreads = byId(previous.projects.flatMap((project) => project.threads))
  const projects: EngineProjectView[] = []
  for (const projectDelta of delta.projects) {
    const before = previousProjects.get(projectDelta.id)
    const body = projectDelta.project ?? (before ? projectBody(before) : null)
    if (!body) return null
    const threads: EngineThreadView[] = []
    let threadsChanged = !before || before.threads.length !== projectDelta.threads.length
    for (const threadDelta of projectDelta.threads) {
      const previousThread = previousThreads.get(threadDelta.id)
      if (!threadDelta.thread && !threadDelta.messages && !threadDelta.activities) {
        if (!previousThread) return null
        threads.push(previousThread)
        continue
      }
      threadsChanged = true
      const threadBase = threadDelta.thread ?? (previousThread ? threadBody(previousThread) : null)
      if (!threadBase) return null
      const messages = applyList(previousThread?.messages, threadDelta.messages)
      const activities = applyList(previousThread?.activities, threadDelta.activities)
      if (!messages || !activities) return null
      threads.push({ ...threadBase, messages, activities })
    }
    if (!threadsChanged && before) threadsChanged = before.threads.some((thread, index) => threads[index] !== thread)
    if (before && !projectDelta.project && !threadsChanged) projects.push(before)
    else projects.push({ ...body, threads })
  }
  return { ...delta.engine, projects }
}

/** Longest common prefix and suffix, so one edit region travels instead of the document. */
export function spliceContent(previous: string, next: string): ContentSplice {
  const shortest = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1
  }
  return { prefix, suffix, insert: next.slice(prefix, next.length - suffix), length: next.length }
}

export function applyContentSplice(previous: string, splice: ContentSplice): string | null {
  if (splice.prefix + splice.suffix > previous.length) return null
  const result = previous.slice(0, splice.prefix) + splice.insert + previous.slice(previous.length - splice.suffix)
  return result.length === splice.length ? result : null
}

export function encodeViewUpdate(previous: SyncedView | null, seq: number, next: AppView, verify: boolean): ViewUpdate {
  if (previous === null) return { seq, full: next }
  const sections: NonNullable<ViewUpdate['sections']> = {}
  if (next.tabs !== previous.view.tabs) sections.tabs = next.tabs
  if (next.explorer !== previous.view.explorer) sections.explorer = next.explorer
  if (next.settings !== previous.view.settings) sections.settings = next.settings
  if (next.engine !== previous.view.engine) sections.engineDelta = encodeEngineDelta(previous.view.engine, next.engine)
  if (next.preview !== previous.view.preview) sections.preview = next.preview
  if (next.activeDocument !== previous.view.activeDocument) {
    if (next.activeDocument === null) {
      sections.activeDocument = null
    } else {
      const { content, ...document } = next.activeDocument
      const previousContent = previous.view.activeDocument?.content
      let encoded: ActiveDocumentSection['content']
      if (previousContent === content) {
        encoded = { unchanged: true }
      } else if (previousContent === undefined) {
        encoded = { text: content }
      } else {
        const splice = spliceContent(previousContent, content)
        encoded = splice.insert.length < content.length / 2 ? { splice } : { text: content }
      }
      sections.activeDocument = { document, content: encoded }
    }
  }
  return { seq, base: previous.seq, sections, ...(verify ? { verify: next } : {}) }
}

export type ApplyResult =
  | { status: 'applied'; synced: SyncedView }
  | { status: 'resync' }

export function applyViewUpdate(current: SyncedView | null, update: ViewUpdate): ApplyResult {
  if (update.full !== undefined) {
    return { status: 'applied', synced: { seq: update.seq, view: update.full } }
  }
  if (current === null || update.base !== current.seq || update.sections === undefined) {
    return { status: 'resync' }
  }
  const sections = update.sections
  let activeDocument = current.view.activeDocument
  if ('activeDocument' in sections) {
    const section = sections.activeDocument
    if (section === null || section === undefined) {
      activeDocument = null
    } else if ('text' in section.content) {
      activeDocument = { ...section.document, content: section.content.text }
    } else if (current.view.activeDocument === null) {
      return { status: 'resync' }
    } else if ('splice' in section.content) {
      const spliced = applyContentSplice(current.view.activeDocument.content, section.content.splice)
      if (spliced === null) return { status: 'resync' }
      activeDocument = { ...section.document, content: spliced }
    } else {
      activeDocument = { ...section.document, content: current.view.activeDocument.content }
    }
  }
  let engine = sections.engine ?? current.view.engine
  if (sections.engineDelta !== undefined) {
    const applied = applyEngineDelta(current.view.engine, sections.engineDelta)
    if (applied === null) return { status: 'resync' }
    engine = applied
  }
  const view: AppView = {
    tabs: sections.tabs ?? current.view.tabs,
    explorer: sections.explorer ?? current.view.explorer,
    settings: sections.settings ?? current.view.settings,
    engine,
    preview: sections.preview ?? current.view.preview,
    activeDocument,
  }
  return { status: 'applied', synced: { seq: update.seq, view } }
}

export function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  if (keys.length !== Object.keys(rightRecord).length) return false
  return keys.every((key) => key in rightRecord && sameJson(leftRecord[key], rightRecord[key]))
}

export function isViewUpdate(value: unknown): value is ViewUpdate {
  if (!value || typeof value !== 'object') return false
  const update = value as Partial<ViewUpdate>
  if (typeof update.seq !== 'number') return false
  if (update.full !== undefined) return true
  return typeof update.base === 'number' && typeof update.sections === 'object' && update.sections !== null
}
