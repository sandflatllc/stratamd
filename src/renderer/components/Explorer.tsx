import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { ExplorerFileView, ExplorerFolderView } from '../../shared/contracts'
import { explorerTree, type ExplorerTreeNode } from '../model'
import { AmbientDecor } from './AmbientDecor'
import { PathContextMenu, type PathContextMenuState, type PathMenuActions } from './PathContextMenu'

interface ExplorerProps {
  embedded?: boolean
  folders: ExplorerFolderView[]
  activePath?: string
  /** Recently opened documents, newest first (§5.10). */
  recents?: readonly string[]
  scanning: boolean
  onOpen(path: string): void
  onScan(path: string): void
  onRefresh(): void
  onAddFolder(): void
  onOpenFile?(): void
  onForget(path: string): void
  onCopyPath(path: string): void
  onRemoveFolder(path: string): void
  onNewFile?(directory: string): void
  onRename?(path: string): void
  onTrash?(path: string): void
  onReveal?(path: string): void
}

/** Root folder label: the folder name, preceded by its parent when there is one. The name is never elided. */
export function rootFolderLabel(path: string): { parent: string; name: string } {
  const parts = path.split('/').filter(Boolean)
  const name = parts.at(-1) ?? path
  const parent = parts.at(-2)
  return { parent: parent === undefined ? '' : `${parent}/`, name }
}

/** The folder paths between a root and one of its files, outermost first (§5.10 reveal). */
export function ancestorFolders(folder: { path: string; files: readonly ExplorerFileView[] }, filePath: string): string[] {
  const file = folder.files.find((entry) => entry.path === filePath)
  if (!file) return []
  const parts = file.relativePath.split('/').slice(0, -1)
  const result: string[] = []
  let current = folder.path
  for (const part of parts) {
    current = `${current}/${part}`
    result.push(current)
  }
  return result
}

const PREPARE_HINT = 'Finds every markdown file in this folder and remembers it, so agents can open any of them and you can review their changes.'

function FileRow({ file, depth, activePath, onOpen, onForget, onContextMenu }: {
  file: ExplorerFileView
  depth: number
  activePath: string | undefined
  onOpen(path: string): void
  onForget(path: string): void
  onContextMenu(event: ReactMouseEvent, path: string): void
}) {
  const active = file.path === activePath
  return (
    <div
      className={`file-row ${active ? 'active' : ''} ${file.missing ? 'missing' : ''}`}
      style={{ '--depth': depth } as CSSProperties}
      role="treeitem"
      aria-level={depth + 2}
      aria-selected={active}
      data-tree-path={file.path}
      onContextMenu={(event) => onContextMenu(event, file.path)}
    >
      <button type="button" tabIndex={active ? 0 : -1} onClick={() => onOpen(file.path)} title={file.path}>
        <span>{file.name}</span>
        {file.pendingCount > 0 && <span className="file-count">{file.pendingCount}</span>}
      </button>
      {file.missing && <button type="button" className="forget" onClick={() => onForget(file.path)}>forget</button>}
    </div>
  )
}

function FolderRow({ label, path, depth, collapsed, onToggle, onContextMenu }: {
  label: string
  path: string
  depth: number
  collapsed: boolean
  onToggle(path: string): void
  onContextMenu(event: ReactMouseEvent, path: string): void
}) {
  const root = depth === 0 ? rootFolderLabel(path) : null
  return (
    <button
      type="button"
      className={`folder-row ${depth > 0 ? 'subfolder' : ''}`}
      style={{ '--depth': Math.max(0, depth - 1) } as CSSProperties}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={!collapsed}
      tabIndex={-1}
      data-tree-path={path}
      data-tree-folder="true"
      title={path}
      onClick={() => onToggle(path)}
      onContextMenu={(event) => onContextMenu(event, path)}
    >
      <span className="disclosure">{collapsed ? '▸' : '▾'}</span>
      {root ? <><span className="folder-parent">{root.parent}</span><span className="folder-name">{root.name}</span></> : <span className="folder-name">{label}</span>}
    </button>
  )
}

function Subtree({ node, depth, activePath, toggled, onToggle, onOpen, onForget, onContextMenu, onFolderContextMenu }: {
  node: ExplorerTreeNode
  depth: number
  activePath: string | undefined
  /** Paths whose default open/closed state has been flipped. Roots default open; subfolders default closed. */
  toggled: ReadonlySet<string>
  onToggle(path: string): void
  onOpen(path: string): void
  onForget(path: string): void
  onContextMenu(event: ReactMouseEvent, path: string): void
  onFolderContextMenu(event: ReactMouseEvent, path: string): void
}) {
  return (
    <>
      {node.folders.map((folder) => (
        <div key={folder.path} role="group">
          <FolderRow label={folder.name} path={folder.path} depth={depth + 1} collapsed={!toggled.has(folder.path)} onToggle={onToggle} onContextMenu={onFolderContextMenu} />
          {toggled.has(folder.path) && (
            <Subtree node={folder} depth={depth + 1} activePath={activePath} toggled={toggled} onToggle={onToggle} onOpen={onOpen} onForget={onForget} onContextMenu={onContextMenu} onFolderContextMenu={onFolderContextMenu} />
          )}
        </div>
      ))}
      {node.files.map((file) => (
        <FileRow key={file.path} file={file} depth={depth} activePath={activePath} onOpen={onOpen} onForget={onForget} onContextMenu={onContextMenu} />
      ))}
    </>
  )
}

export function Explorer({ embedded = false, folders, activePath, recents = [], scanning, onOpen, onScan, onRefresh, onAddFolder, onOpenFile, onForget, onCopyPath, onRemoveFolder, onNewFile, onRename, onTrash, onReveal }: ExplorerProps) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<PathContextMenuState | null>(null)
  const tree = useRef<HTMLDivElement>(null)
  const openMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path })
  }
  const openFolderMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path, folder: true })
  }
  const openRootMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path, root: true, folder: true })
  }
  const closeMenu = () => setMenu(null)
  const toggle = (path: string) => setToggled((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  // The active document is always visible: its ancestors open when it changes (§5.10).
  useEffect(() => {
    if (!activePath) return
    setToggled((previous) => {
      const next = new Set(previous)
      let changed = false
      for (const folder of folders) {
        const ancestors = ancestorFolders(folder, activePath)
        if (ancestors.length === 0 && !folder.files.some((file) => file.path === activePath)) continue
        if (next.has(folder.path)) { next.delete(folder.path); changed = true }
        for (const ancestor of ancestors) if (!next.has(ancestor)) { next.add(ancestor); changed = true }
      }
      return changed ? next : previous
    })
    window.requestAnimationFrame(() => {
      tree.current?.querySelector<HTMLElement>('.file-row.active')?.scrollIntoView({ block: 'nearest' })
    })
  }, [activePath, folders])

  // Tree keys (§5.13): Up and Down walk the visible rows, Right opens a folder, Left closes it or moves to its parent.
  const treeKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    const focusOf = (row: HTMLElement): HTMLElement => row.matches('button') ? row : row.querySelector<HTMLElement>('button') ?? row
    const current = rows.findIndex((row) => row === event.target || row.contains(event.target as Node))
    if (current < 0) return
    const row = rows[current]!
    const focusRow = (index: number) => {
      const target = rows[index]
      if (!target) return
      for (const other of rows) focusOf(other).tabIndex = -1
      const focusable = focusOf(target)
      focusable.tabIndex = 0
      focusable.focus()
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(Math.min(rows.length - 1, current + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusRow(Math.max(0, current - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); focusRow(0) }
    else if (event.key === 'End') { event.preventDefault(); focusRow(rows.length - 1) }
    else if (event.key === 'ArrowRight' && row.dataset.treeFolder === 'true') {
      event.preventDefault()
      if (row.getAttribute('aria-expanded') === 'false') toggle(row.dataset.treePath!)
      else focusRow(current + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.dataset.treeFolder === 'true' && row.getAttribute('aria-expanded') === 'true') { toggle(row.dataset.treePath!); return }
      const level = Number(row.getAttribute('aria-level') ?? 1)
      for (let index = current - 1; index >= 0; index -= 1) {
        if (Number(rows[index]!.getAttribute('aria-level') ?? 1) < level) { focusRow(index); return }
      }
    }
  }

  const files = folders.flatMap((folder) => folder.files)
  const missing = files.filter((file) => file.missing).length
  const menuActions: PathMenuActions = {
    onCopyPath,
    onRemoveFolder,
    onOpen,
    ...(onNewFile ? { onNewFile } : {}),
    ...(onRename ? { onRename } : {}),
    ...(onTrash ? { onTrash } : {}),
    ...(onReveal ? { onReveal } : {}),
  }
  return (
    <aside className={`explorer ${embedded ? 'explorer-embedded' : 'island'}`} aria-label="File explorer">
      {!embedded && <AmbientDecor variant="explorer" />}
      <div className="panel-heading">
        <h2>Files</h2>
        <div>
          {folders.length === 1 && <button type="button" className="text-action positive" title={PREPARE_HINT} onClick={() => onScan(folders[0]!.path)}>Prepare for review</button>}
          {onOpenFile && <button type="button" className="refresh" onClick={onOpenFile} aria-label="Open a file" title="Open a file">…</button>}
          <button type="button" className="refresh" onClick={onRefresh} aria-label="Refresh explorer" title="Refresh the file list">⟳</button>
        </div>
      </div>
      <div className={`tree ${scanning ? 'scanning' : ''}`} ref={tree} role="tree" aria-label="Documents" onKeyDown={treeKeys}>
        {recents.length > 0 && (
          <section className="recents" aria-label="Recent documents">
            <h3>Recent</h3>
            {recents.map((path) => (
              <div className={`file-row recent-row ${path === activePath ? 'active' : ''}`} role="treeitem" aria-level={1} aria-selected={path === activePath} data-tree-path={path} key={path} onContextMenu={(event) => openMenu(event, path)}>
                <button type="button" tabIndex={-1} aria-label={`Open recent ${path.split('/').pop() ?? path}`} onClick={() => onOpen(path)} title={path}><span>{path.split('/').pop()}</span></button>
              </div>
            ))}
          </section>
        )}
        {folders.map((folder) => (
          <section key={folder.path} role="group">
            <FolderRow label={folder.name} path={folder.path} depth={0} collapsed={toggled.has(folder.path)} onToggle={toggle} onContextMenu={openRootMenu} />
            {!toggled.has(folder.path) && (
              <Subtree node={explorerTree(folder)} depth={0} activePath={activePath} toggled={toggled} onToggle={toggle} onOpen={onOpen} onForget={onForget} onContextMenu={openMenu} onFolderContextMenu={openFolderMenu} />
            )}
            <button type="button" className="scan-folder" title={PREPARE_HINT} onClick={() => onScan(folder.path)}>Prepare this folder for review</button>
          </section>
        ))}
        <button type="button" className="add-folder" onClick={onAddFolder}>+ Add folder</button>
      </div>
      <div className="explorer-spacer" />
      {menu && <PathContextMenu menu={menu} onClose={closeMenu} {...menuActions} />}
      <div className="explorer-note">{scanning ? 'Looking for markdown files…' : files.length > 0 ? `Up to date · ${files.length} file${files.length === 1 ? '' : 's'}${missing ? ` · ${missing} missing` : ''}` : '0 markdown files'}</div>
    </aside>
  )
}
