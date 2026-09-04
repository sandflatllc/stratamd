import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { buildProjectsRail, resolveShelfThreads, type ProjectShelfEntry, type ProjectThreadSort } from '../../core/projects-rail'
import type { EngineThreadChange, EngineThreadView, EngineView } from '../../shared/contracts'

interface ProjectsPanelProps {
  engine: EngineView
  onOpenThread(threadId: string): void
  onBeginRename(): void
  onReconnect(): void
  onNewThread(projectId?: string): void
  onAddProject(input: { title: string; workspaceRoot: string }): void
  onAction(threadId: string, action: 'archive' | 'settle' | 'unsettle' | 'delete'): void
  onUpdate(threadId: string, change: EngineThreadChange): void
  onOpenEngine?(): void
  onOpenAccounts?(): void
  attachedThreadIds?: ReadonlySet<string>
  now?: () => number
}

interface FolderPreference { open: boolean; previewCount: number }
type FolderPreferences = Record<string, FolderPreference>

const PREFERENCES_KEY = 'stratamd.projects-rail.v1'

function readPreferences(): FolderPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(value).flatMap(([id, raw]) => {
      if (typeof raw !== 'object' || raw === null) return []
      const entry = raw as Partial<FolderPreference>
      return [[id, { open: entry.open !== false, previewCount: typeof entry.previewCount === 'number' && entry.previewCount > 0 ? Math.floor(entry.previewCount) : 5 }]]
    }))
  } catch { return {} }
}

export function snoozeUntil(choice: 'hour' | 'tomorrow' | 'week', nowMs: number): string {
  const date = new Date(nowMs)
  if (choice === 'hour') return new Date(nowMs + 3_600_000).toISOString()
  date.setDate(date.getDate() + (choice === 'tomorrow' ? 1 : 7))
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}

export function relativeTime(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function ThreadStatus({ thread }: { thread: EngineThreadView }) {
  if (thread.status === 'running' || thread.status === 'starting') return <span className="project-thread-status working"><i aria-hidden="true" />Working</span>
  if (thread.pendingApprovals) return <span className="project-thread-status attention" title="Approval needed">Approval</span>
  if (thread.pendingUserInput) return <span className="project-thread-status attention" title="Input needed">Input</span>
  return null
}

function RenameInput({ thread, onUpdate, onDone }: { thread: EngineThreadView; onUpdate(threadId: string, change: EngineThreadChange): void; onDone(): void }) {
  const [title, setTitle] = useState(thread.title)
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const commit = () => { if (finished.current) return; finished.current = true; const next = title.trim(); if (next && next !== thread.title) onUpdate(thread.id, { title: next }); onDone() }
  const cancel = () => { if (finished.current) return; finished.current = true; onDone() }
  return <input ref={input} className="project-thread-rename" aria-label={`Rename ${thread.title}`} value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); window.setTimeout(commit, 0) } if (event.key === 'Escape') { event.preventDefault(); window.setTimeout(cancel, 0) } }} />
}

interface ThreadRowProps {
  thread: EngineThreadView
  projectName?: string
  active: boolean
  attached: boolean
  nowMs: number
  shelf?: 'snoozed' | 'settled'
  renaming: boolean
  onRename(): void
  onOpen(): void
  onMenu(event: MouseEvent): void
  onUpdate(change: EngineThreadChange): void
  onAction(action: 'settle' | 'unsettle'): void
  onDoneRenaming(): void
}

function ThreadRow({ thread, projectName, active, attached, nowMs, shelf, renaming, onRename, onOpen, onMenu, onUpdate, onAction, onDoneRenaming }: ThreadRowProps) {
  return <div className={`project-thread ${active ? 'active' : ''}`} data-thread={thread.id} data-pinned={thread.pinnedAt !== null} data-lifecycle={thread.lifecycle} onContextMenu={onMenu}>
    <button type="button" className="project-thread-star" aria-label={`${thread.pinnedAt ? 'Unpin' : 'Pin'} ${thread.title}`} aria-pressed={thread.pinnedAt !== null} onClick={() => onUpdate({ pinned: thread.pinnedAt === null })}>{thread.pinnedAt ? '★' : '☆'}</button>
    {shelf && projectName && <span className="project-thread-project">{projectName}</span>}
    <ThreadStatus thread={thread} />
    {renaming ? <RenameInput thread={thread} onUpdate={(_id, change) => onUpdate(change)} onDone={onDoneRenaming} /> : <button type="button" className="project-thread-open" aria-label={`Open ${thread.title}`} onClick={onOpen} onDoubleClick={(event) => { event.preventDefault(); onRename() }}><span className={thread.unread ? 'unread' : undefined}>{thread.title}</span></button>}
    <span className="project-thread-marks">{attached && <i className="attached-mark" aria-label="Attached" title="Attached">⌁</i>}{thread.pendingWork > 0 && <b aria-label={`${thread.pendingWork} pending work`}>{thread.pendingWork}</b>}</span>
    <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt, nowMs)}</time>
    {shelf ? <button type="button" className="project-thread-restore" onClick={() => shelf === 'snoozed' ? onUpdate({ snoozedUntil: null }) : onAction('unsettle')}>Restore</button> : <button type="button" className="project-thread-settle" aria-label={`Settle ${thread.title}`} onClick={() => onAction('settle')}>✓</button>}
  </div>
}

function ThreadMenu({ thread, x, y, nowMs, onClose, onRename, onUpdate, onAction }: { thread: EngineThreadView; x: number; y: number; nowMs: number; onClose(): void; onRename(): void; onUpdate(change: EngineThreadChange): void; onAction(action: 'archive' | 'settle' | 'unsettle' | 'delete'): void }) {
  const run = (action: () => void) => { action(); onClose() }
  return <div className="project-thread-menu" role="menu" aria-label={`Actions for ${thread.title}`} style={{ left: x, top: y }} onMouseDown={(event) => event.stopPropagation()}>
    <button type="button" role="menuitem" onClick={() => run(() => onUpdate({ pinned: thread.pinnedAt === null }))}>{thread.pinnedAt ? 'Unpin' : 'Pin'}</button>
    <button type="button" role="menuitem" onClick={() => run(onRename)}>Rename thread</button>
    {thread.lifecycle === 'snoozed' ? <button type="button" role="menuitem" onClick={() => run(() => onUpdate({ snoozedUntil: null }))}>Unsnooze</button> : <><span className="project-menu-label">Snooze</span>{([['hour', 'An hour'], ['tomorrow', 'Tomorrow'], ['week', 'Next week']] as const).map(([choice, label]) => <button type="button" role="menuitem" className="project-menu-nested" key={choice} onClick={() => run(() => onUpdate({ snoozedUntil: snoozeUntil(choice, nowMs) }))}>{label}</button>)}</>}
    <button type="button" role="menuitem" onClick={() => run(() => onAction(thread.lifecycle === 'settled' ? 'unsettle' : 'settle'))}>{thread.lifecycle === 'settled' ? 'Unsettle' : 'Settle'}</button>
    <button type="button" role="menuitem" onClick={() => run(() => onUpdate({ unread: true }))}>Mark unread</button>
    <button type="button" role="menuitem" onClick={() => run(() => void navigator.clipboard.writeText(thread.id))}>Copy Thread ID</button>
    <button type="button" role="menuitem" onClick={() => run(() => onAction('archive'))}>Archive</button>
    <button type="button" role="menuitem" className="destructive" onClick={() => run(() => onAction('delete'))}>Delete</button>
  </div>
}

function Shelf({ label, entries, activeThreadId, expanded, visibleCount, nowMs, renamingId, attachedThreadIds, onToggle, onMore, onRename, onDoneRenaming, onOpenThread, onMenu, onUpdate, onAction }: { label: 'Snoozed' | 'Settled'; entries: ProjectShelfEntry[]; activeThreadId: string | null; expanded: boolean; visibleCount: number; nowMs: number; renamingId: string | null; attachedThreadIds: ReadonlySet<string>; onToggle(): void; onMore(): void; onRename(threadId: string): void; onDoneRenaming(): void; onOpenThread(threadId: string): void; onMenu(event: MouseEvent, thread: EngineThreadView): void; onUpdate(threadId: string, change: EngineThreadChange): void; onAction(threadId: string, action: 'unsettle'): void }) {
  const visible = resolveShelfThreads(entries, expanded, visibleCount, activeThreadId)
  const hidden = Math.max(0, entries.length - visible.length)
  return <section className="project-shelf" data-expanded={expanded}>
    <button type="button" className="project-shelf-header" aria-expanded={expanded} onClick={onToggle}><i aria-hidden="true">›</i><span>{label}</span><b>{entries.length}</b></button>
    {visible.map((entry) => <ThreadRow key={entry.thread.id} thread={entry.thread} projectName={entry.projectName} active={entry.thread.id === activeThreadId} attached={attachedThreadIds.has(entry.thread.id)} nowMs={nowMs} shelf={label.toLocaleLowerCase() as 'snoozed' | 'settled'} renaming={renamingId === entry.thread.id} onRename={() => onRename(entry.thread.id)} onDoneRenaming={onDoneRenaming} onOpen={() => onOpenThread(entry.thread.id)} onMenu={(event) => onMenu(event, entry.thread)} onUpdate={(change) => onUpdate(entry.thread.id, change)} onAction={() => onAction(entry.thread.id, 'unsettle')} />)}
    {expanded && hidden > 0 && <button type="button" className="project-show-more" onClick={onMore}>Show more ({hidden})</button>}
  </section>
}

export function ProjectsPanel({ engine, onOpenThread, onBeginRename, onReconnect, onNewThread, onAddProject, onAction, onUpdate, onOpenEngine, attachedThreadIds = new Set(), now = Date.now }: ProjectsPanelProps) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ProjectThreadSort>('recent')
  const [preferences, setPreferences] = useState<FolderPreferences>(readPreferences)
  const [shelves, setShelves] = useState({ snoozed: false, settled: false })
  const [shelfCounts, setShelfCounts] = useState({ snoozed: 5, settled: 5 })
  const [menu, setMenu] = useState<{ thread: EngineThreadView; x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [addingProject, setAddingProject] = useState(false)
  const [projectTitle, setProjectTitle] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)) } catch { /* Disposable view preference. */ } }, [preferences])
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); search.current?.focus() }
    }
    const close = () => setMenu(null)
    window.addEventListener('keydown', keydown)
    window.addEventListener('mousedown', close)
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('mousedown', close) }
  }, [])

  const nowMs = now()
  const previewCountByProject = Object.fromEntries(engine.projects.map((project) => [project.id, preferences[project.id]?.previewCount ?? 5]))
  const rail = buildProjectsRail(engine.projects, { nowMs, sort, previewCountByProject })
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => normalizedQuery ? {
    folders: rail.folders.map((folder) => ({ ...folder, visibleThreads: folder.threads.filter((thread) => thread.title.toLocaleLowerCase().includes(normalizedQuery)) })),
    snoozed: rail.snoozed.filter((entry) => `${entry.projectName} ${entry.thread.title}`.toLocaleLowerCase().includes(normalizedQuery)),
    settled: rail.settled.filter((entry) => `${entry.projectName} ${entry.thread.title}`.toLocaleLowerCase().includes(normalizedQuery)),
  } : rail, [normalizedQuery, rail])
  const preference = (projectId: string) => preferences[projectId] ?? { open: true, previewCount: 5 }
  const updatePreference = (projectId: string, patch: Partial<FolderPreference>) => setPreferences((current) => ({ ...current, [projectId]: { ...preference(projectId), ...patch } }))
  const beginRename = (threadId: string) => { onBeginRename(); setRenamingId(threadId) }
  const openMenu = (event: MouseEvent, thread: EngineThreadView) => { event.preventDefault(); setMenu({ thread, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 330) }) }
  const submitProject = (event: FormEvent) => { event.preventDefault(); if (!projectPath.trim()) return; onAddProject({ title: projectTitle.trim() || projectPath.trim().split('/').at(-1) || 'Project', workspaceRoot: projectPath.trim() }); setAddingProject(false); setProjectTitle(''); setProjectPath('') }

  if (engine.state === 'unpaired') return <div className="engine-empty" data-testid="engine-unpaired">No engine paired.<small>Pair StrataMD with your T3 server to see its projects.</small>{onOpenEngine && <button type="button" onClick={onOpenEngine}>Pair engine</button>}</div>
  if (engine.state === 'disconnected' || engine.state === 'connecting') return <div className="engine-empty" data-testid="engine-disconnected">{engine.server ?? 'Engine'} is {engine.state === 'connecting' ? 'connecting' : 'disconnected'}.<button type="button" onClick={onReconnect}>Reconnect</button></div>

  return <div className="projects-panel">
    <div className="projects-search"><span aria-hidden="true">⌕</span><input ref={search} type="search" aria-label="Search threads" placeholder="Search threads" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>Ctrl K</kbd></div>
    <header className="projects-header"><h2>Projects</h2><label title="Sort threads"><span className="sr-only">Sort projects</span><select aria-label="Sort projects" value={sort} onChange={(event) => setSort(event.target.value as ProjectThreadSort)}><option value="recent">Recent</option><option value="oldest">Oldest</option><option value="title">Name</option></select></label><button type="button" aria-label="Add project" title="Add project" onClick={() => setAddingProject((value) => !value)}>＋</button></header>
    <div className="projects-primary-actions"><button type="button" title="New thread (Ctrl+Shift+N)" onClick={() => onNewThread()}>New thread</button></div>
    {addingProject && <form className="projects-add-form" aria-label="Add project" onSubmit={submitProject}><input aria-label="Project title" placeholder="Project name" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><input aria-label="Project folder" placeholder="/path/to/folder" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /><div><button type="button" onClick={() => setAddingProject(false)}>Cancel</button><button type="submit" disabled={!projectPath.trim()}>Add</button></div></form>}
    <div className="project-folders">
      {filtered.folders.map((folder) => {
        const state = preference(folder.project.id)
        return <section className="project-group" key={folder.project.id} data-open={state.open}>
          <div className="project-folder-row"><button type="button" className="project-folder-header" aria-expanded={state.open} title={folder.project.workspaceRoot} onClick={() => updatePreference(folder.project.id, { open: !state.open })}><i className="project-folder-chevron" aria-hidden="true">›</i><span className="project-folder-icon" aria-hidden="true">▱</span><strong>{folder.project.title}</strong>{folder.unread && <span className="unread-dot" aria-label="Unread threads" />}</button><button type="button" className="project-new-thread" aria-label={`New thread in ${folder.project.title}`} title={`New thread in ${folder.project.title}`} onClick={() => onNewThread(folder.project.id)}>＋</button></div>
          {state.open && <>{folder.visibleThreads.map((thread) => <ThreadRow key={thread.id} thread={thread} active={thread.id === engine.activeThreadId} attached={attachedThreadIds.has(thread.id)} nowMs={nowMs} renaming={renamingId === thread.id} onRename={() => beginRename(thread.id)} onDoneRenaming={() => setRenamingId(null)} onOpen={() => onOpenThread(thread.id)} onMenu={(event) => openMenu(event, thread)} onUpdate={(change) => onUpdate(thread.id, change)} onAction={(action) => onAction(thread.id, action)} />)}{folder.hasOverflow && folder.visibleThreads.length < folder.threads.length && <button type="button" className="project-show-more" onClick={() => updatePreference(folder.project.id, { previewCount: state.previewCount + 5 })}>Show more ({folder.threads.length - folder.visibleThreads.length})</button>}{folder.threads.length === 0 && <div className="empty-subtle">No active threads.</div>}</>}
        </section>
      })}
    </div>
    <Shelf label="Snoozed" entries={filtered.snoozed} activeThreadId={engine.activeThreadId} expanded={shelves.snoozed || Boolean(normalizedQuery)} visibleCount={shelfCounts.snoozed} nowMs={nowMs} renamingId={renamingId} attachedThreadIds={attachedThreadIds} onToggle={() => setShelves((value) => ({ ...value, snoozed: !value.snoozed }))} onMore={() => setShelfCounts((value) => ({ ...value, snoozed: value.snoozed + 5 }))} onRename={beginRename} onDoneRenaming={() => setRenamingId(null)} onOpenThread={onOpenThread} onMenu={openMenu} onUpdate={onUpdate} onAction={(id) => onAction(id, 'unsettle')} />
    <Shelf label="Settled" entries={filtered.settled} activeThreadId={engine.activeThreadId} expanded={shelves.settled || Boolean(normalizedQuery)} visibleCount={shelfCounts.settled} nowMs={nowMs} renamingId={renamingId} attachedThreadIds={attachedThreadIds} onToggle={() => setShelves((value) => ({ ...value, settled: !value.settled }))} onMore={() => setShelfCounts((value) => ({ ...value, settled: value.settled + 5 }))} onRename={beginRename} onDoneRenaming={() => setRenamingId(null)} onOpenThread={onOpenThread} onMenu={openMenu} onUpdate={onUpdate} onAction={(id) => onAction(id, 'unsettle')} />
    {menu && <ThreadMenu thread={menu.thread} x={menu.x} y={menu.y} nowMs={nowMs} onClose={() => setMenu(null)} onRename={() => beginRename(menu.thread.id)} onUpdate={(change) => onUpdate(menu.thread.id, change)} onAction={(action) => onAction(menu.thread.id, action)} />}
  </div>
}
