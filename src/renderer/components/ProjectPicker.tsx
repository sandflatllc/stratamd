import { useEffect, useRef, useState } from 'react'
import type { EngineProjectView } from '../../shared/contracts'
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon, SearchIcon } from '../icons/lucide'
import { claimEscape } from '../escape'

/** Projects at or above this count get a filter line at the top of the menu. */
const FILTER_THRESHOLD = 8

/** The Project pill on the new-thread screen: a Strata popover in place of the native select. */
export function ProjectPicker({ projects, value, onChange, onAdd }: { projects: readonly EngineProjectView[]; value: string; onChange(projectId: string): void; onAdd(): void }) {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { claimEscape(event); setOpen(false) } }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key, true) }
  }, [open])
  const current = projects.find(project => project.id === value)
  const filter = projects.length >= FILTER_THRESHOLD
  const shown = query ? projects.filter(project => project.title.toLowerCase().includes(query.toLowerCase())) : projects
  const toggle = () => { setQuery(''); setOpen(!open) }
  const count = (project: EngineProjectView) => `${project.threads.length} thread${project.threads.length === 1 ? '' : 's'}`
  return <div className="project-picker" ref={root}>
    <button type="button" className="project-picker-trigger" aria-label="Conversation project" aria-haspopup="true" aria-expanded={open} data-value={value} onClick={toggle}><FolderIcon />{current?.title ?? 'Choose a project'}<ChevronDownIcon /></button>
    {open && <div className="workspace-menu project-menu" role="region" aria-label="Projects">
      {filter && <label className="project-menu-filter"><SearchIcon /><input type="search" aria-label="Find a project" placeholder="Find a project" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} /></label>}
      <div className="project-menu-list" role="group" aria-label="Choose a project">
        {shown.map(project => <button type="button" key={project.id} aria-pressed={project.id === value} onClick={() => { onChange(project.id); setOpen(false) }}><FolderIcon /><span>{project.title}</span>{project.id === value ? <CheckIcon /> : <small>{count(project)}</small>}</button>)}
        {shown.length === 0 && <p>No project matches {query}.</p>}
      </div>
      <button type="button" className="project-menu-add" onClick={() => { setOpen(false); onAdd() }}><PlusIcon />Add project</button>
    </div>}
  </div>
}
