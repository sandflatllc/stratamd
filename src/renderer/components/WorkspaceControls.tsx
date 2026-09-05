import { useEffect, useRef, useState } from 'react'
import type { EngineProjectView, EngineRefs, WorktreeRequest } from '../../shared/contracts'
import { FolderIcon, FolderGit2Icon, GitBranchIcon, HistoryIcon, ChevronDownIcon } from '../icons/lucide'
import { Switch } from './Switch'
import { claimEscape } from '../escape'

export type WorkspaceChoice = { kind: 'current' } | WorktreeRequest | { kind: 'previous'; worktreePath: string; branch: string | null }
export function WorkspaceControls({ project, value, onChange, disabled }: { project: EngineProjectView; value: WorkspaceChoice; onChange(value: WorkspaceChoice): void; disabled: boolean }) {
  const [menu, setMenu] = useState<'workspace' | 'refs' | null>(null)
  const [refs, setRefs] = useState<EngineRefs | null>(null)
  const [query, setQuery] = useState('')
  const [originDefault, setOriginDefault] = useState(true)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const previous = [...new Map(project.threads.filter(thread => !thread.archived && thread.worktreePath).map(thread => [thread.worktreePath!, thread])).values()]
  useEffect(() => {
    let current = true
    void window.strata.readEngineSettings().then(settings => { if (current) setOriginDefault(settings.newWorktreesStartFromOrigin ?? true) }).catch(() => undefined)
    return () => { current = false }
  }, [])
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      void window.strata.listEngineRefs(project.workspaceRoot, query).then(result => {
        if (!current) return
        setRefs(result); setError('')
        const branch = result.refs.find(ref => ref.current)?.name
        if (branch) setCurrentBranch(branch)
      }).catch(failure => { if (current) { setRefs(null); setError(String(failure)) } })
    }, query ? 150 : 0)
    return () => { current = false; clearTimeout(timer) }
  }, [project.workspaceRoot, query])
  useEffect(() => {
    if (!menu) return
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(null) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { claimEscape(event); setMenu(null) } }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key, true) }
  }, [menu])
  const current = currentBranch ?? project.threads.find(thread => !thread.worktreePath)?.branch ?? 'Current branch'
  const base = refs?.refs.find(ref => ref.isDefault && !ref.isRemote)?.name ?? currentBranch ?? ''
  const label = value.kind === 'current' ? 'Current checkout' : value.kind === 'worktree' ? 'New worktree' : 'Previous worktree'
  return <div className="workspace-controls" ref={root}>
    <button type="button" aria-label="Workspace" aria-expanded={menu === 'workspace'} disabled={disabled} onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}>{value.kind === 'current' ? <FolderIcon /> : value.kind === 'worktree' ? <FolderGit2Icon /> : <HistoryIcon />}{label}<ChevronDownIcon /></button>
    <button type="button" aria-label="Workspace branch" aria-expanded={menu === 'refs'} disabled={disabled || value.kind === 'previous'} onClick={() => { setQuery(''); setMenu(menu === 'refs' ? null : 'refs') }}><GitBranchIcon />{value.kind === 'worktree' ? `${value.startFromOrigin ? 'From origin/' : 'From '}${value.baseBranch || 'choose a branch'}` : value.kind === 'previous' ? value.branch ?? value.worktreePath : current}<ChevronDownIcon /></button>
    {menu === 'workspace' && <div className="workspace-menu" role="region" aria-label="Workspace choices">
      <button type="button" onClick={() => { onChange({ kind: 'current' }); setMenu(null) }}><FolderIcon /><span>Current checkout<small>Use {project.workspaceRoot}.</small></span></button>
      <button type="button" disabled={!refs?.isRepo} onClick={() => { onChange({ kind: 'worktree', baseBranch: base, startFromOrigin: originDefault && !!refs?.hasPrimaryRemote }); setMenu(null) }}><FolderGit2Icon /><span>New worktree<small>Use a new branch in its own folder.</small></span></button>
      {previous.map(thread => <button type="button" key={thread.worktreePath} onClick={() => { onChange({ kind: 'previous', worktreePath: thread.worktreePath!, branch: thread.branch ?? null }); setMenu(null) }}><HistoryIcon /><span>Previous worktree<small>{thread.worktreePath}</small></span></button>)}
      {error && <p role="alert">{error}</p>}
    </div>}
    {menu === 'refs' && <div className="workspace-menu workspace-refs" role="region" aria-label="Workspace refs">
      <strong>{value.kind === 'worktree' ? 'Start the worktree from' : 'Current checkout'}</strong>
      <input type="search" aria-label="Search refs" placeholder="Search refs" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="workspace-ref-list">{refs?.refs.filter(ref => value.kind === 'worktree' || !ref.isRemote).map(ref => value.kind === 'worktree' ? <button type="button" key={ref.name} onClick={() => { onChange({ ...value, baseBranch: ref.name.replace(/^origin\//, '') }); setMenu(null) }}><GitBranchIcon />{ref.name}{ref.current ? ' · current' : ''}</button> : <div key={ref.name}><GitBranchIcon />{ref.name}{ref.current ? ' · current' : ''}</div>)}</div>
      {value.kind === 'worktree' ? <Switch label="Start from origin" checked={value.startFromOrigin} disabled={!refs?.hasPrimaryRemote} onChange={checked => onChange({ ...value, startFromOrigin: checked })} /> : <p>A worktree uses its own folder. This checkout stays on its current branch.</p>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>
}
