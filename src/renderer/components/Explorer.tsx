import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import type { ExplorerFileView, ExplorerFolderView } from '../../shared/contracts'
import { explorerTree, type ExplorerTreeNode } from '../model'
import { AmbientDecor } from './AmbientDecor'

interface ExplorerProps {
  folders: ExplorerFolderView[]
  activePath?: string
  scanning: boolean
  onOpen(path: string): void
  onScan(path: string): void
  onRefresh(): void
  onAddFolder(): void
  onForget(path: string): void
  onCopyPath(path: string): void
}

/** Root folder label: the folder name, preceded by its parent when there is one. The name is never elided. */
export function rootFolderLabel(path: string): { parent: string; name: string } {
  const parts = path.split('/').filter(Boolean)
  const name = parts.at(-1) ?? path
  const parent = parts.at(-2)
  return { parent: parent === undefined ? '' : `${parent}/`, name }
}

interface ContextMenuState { x: number; y: number; path: string }

function ContextMenu({ menu, onCopyPath, onClose }: { menu: ContextMenuState; onCopyPath(path: string): void; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.querySelector('button')?.focus()
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('contextmenu', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('contextmenu', away, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return (
    <div ref={root} className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onClick={() => { onCopyPath(menu.path); onClose() }}>Copy full path</button>
    </div>
  )
}

function FileRow({ file, depth, activePath, onOpen, onForget, onContextMenu }: {
  file: ExplorerFileView
  depth: number
  activePath: string | undefined
  onOpen(path: string): void
  onForget(path: string): void
  onContextMenu(event: ReactMouseEvent, path: string): void
}) {
  return (
    <div className={`file-row ${file.path === activePath ? 'active' : ''} ${file.missing ? 'missing' : ''}`} style={{ '--depth': depth } as CSSProperties} onContextMenu={(event) => onContextMenu(event, file.path)}>
      <button type="button" onClick={() => onOpen(file.path)} title={file.path}>
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
      aria-expanded={!collapsed}
      title={path}
      onClick={() => onToggle(path)}
      onContextMenu={(event) => onContextMenu(event, path)}
    >
      <span className="disclosure">{collapsed ? '▸' : '▾'}</span>
      {root ? <><span className="folder-parent">{root.parent}</span><span className="folder-name">{root.name}</span></> : <span className="folder-name">{label}</span>}
    </button>
  )
}

function Subtree({ node, depth, activePath, toggled, onToggle, onOpen, onForget, onContextMenu }: {
  node: ExplorerTreeNode
  depth: number
  activePath: string | undefined
  /** Paths whose default open/closed state has been flipped. Roots default open; subfolders default closed. */
  toggled: ReadonlySet<string>
  onToggle(path: string): void
  onOpen(path: string): void
  onForget(path: string): void
  onContextMenu(event: ReactMouseEvent, path: string): void
}) {
  return (
    <>
      {node.folders.map((folder) => (
        <div key={folder.path}>
          <FolderRow label={folder.name} path={folder.path} depth={depth + 1} collapsed={!toggled.has(folder.path)} onToggle={onToggle} onContextMenu={onContextMenu} />
          {toggled.has(folder.path) && (
            <Subtree node={folder} depth={depth + 1} activePath={activePath} toggled={toggled} onToggle={onToggle} onOpen={onOpen} onForget={onForget} onContextMenu={onContextMenu} />
          )}
        </div>
      ))}
      {node.files.map((file) => (
        <FileRow key={file.path} file={file} depth={depth} activePath={activePath} onOpen={onOpen} onForget={onForget} onContextMenu={onContextMenu} />
      ))}
    </>
  )
}

export function Explorer({ folders, activePath, scanning, onOpen, onScan, onRefresh, onAddFolder, onForget, onCopyPath }: ExplorerProps) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const openMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path })
  }
  const closeMenu = () => setMenu(null)
  const toggle = (path: string) => setToggled((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const files = folders.flatMap((folder) => folder.files)
  const missing = files.filter((file) => file.missing).length
  return (
    <aside className="island explorer" aria-label="File explorer">
      <AmbientDecor variant="explorer" />
      <div className="panel-heading">
        <h2>Files</h2>
        <div>
          {folders.length === 1 && <button type="button" className="text-action positive" onClick={() => onScan(folders[0]!.path)}>Scan</button>}
          <button type="button" className="refresh" onClick={onRefresh} aria-label="Refresh explorer">⟳</button>
        </div>
      </div>
      <div className={`tree ${scanning ? 'scanning' : ''}`}>
        {folders.map((folder) => (
          <section key={folder.path}>
            <FolderRow label={folder.name} path={folder.path} depth={0} collapsed={toggled.has(folder.path)} onToggle={toggle} onContextMenu={openMenu} />
            {!toggled.has(folder.path) && (
              <Subtree node={explorerTree(folder)} depth={0} activePath={activePath} toggled={toggled} onToggle={toggle} onOpen={onOpen} onForget={onForget} onContextMenu={openMenu} />
            )}
            <button type="button" className="scan-folder" onClick={() => onScan(folder.path)}>Scan this folder</button>
          </section>
        ))}
        <button type="button" className="add-folder" onClick={onAddFolder}>+ Add folder</button>
      </div>
      <div className="explorer-spacer" />
      {menu && <ContextMenu menu={menu} onCopyPath={onCopyPath} onClose={closeMenu} />}
      <div className="explorer-note">{scanning ? 'Scanning markdown files…' : files.length > 0 ? `Ghosts up to date · ${files.length} file${files.length === 1 ? '' : 's'}${missing ? ` · ${missing} missing` : ''}` : '0 markdown files'}</div>
    </aside>
  )
}
