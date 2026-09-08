import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { NavigationTab } from '../../shared/contracts'
import { claimEscape, isEscapeClaimed } from '../escape'
import { SearchIcon, XIcon } from '../icons/lucide'
import { AmbientDecor } from './AmbientDecor'
import { RailTabs } from './RailTabs'

/** Projects always; Conversation beside a document or preview; Contents beside a document. */
export type LeftTab = NavigationTab

interface NavigationRailProps {
  selected: LeftTab
  documentOpen: boolean
  previewOpen?: boolean
  projects: ReactNode
  conversation: ReactNode
  contents: ReactNode
  projectQuery: string
  onProjectQueryChange(query: string): void
  /** Conversation badge count; absent or zero shows none. */
  conversationCount?: number
  onSelect(tab: LeftTab): void
}

/** Which tabs the left window offers, in order, for the current center content. */
export function leftTabs(documentOpen: boolean, previewOpen = false): LeftTab[] {
  return previewOpen ? ['projects', 'conversation'] : documentOpen ? ['projects', 'conversation', 'contents'] : ['projects']
}

/** The tab to show: the selection when it is offered, otherwise the first offered tab. */
export function resolveLeftTab(selected: LeftTab, documentOpen: boolean, previewOpen = false): LeftTab {
  const offered = leftTabs(documentOpen, previewOpen)
  return offered.includes(selected) ? selected : offered[0]!
}

export function NavigationRail(props: NavigationRailProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const searchPopover = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const latestSearch = useRef({ open: searchOpen, onSelect: props.onSelect })
  useLayoutEffect(() => { latestSearch.current = { open: searchOpen, onSelect: props.onSelect } })
  useLayoutEffect(() => {
    if (searchOpen) { searchInput.current?.focus(); searchInput.current?.select() }
  }, [searchOpen])
  useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (event.defaultPrevented || document.querySelector('[role="dialog"], [aria-modal="true"]')) return
        event.preventDefault()
        latestSearch.current.onSelect('projects')
        setSearchOpen(true)
        searchInput.current?.focus()
      } else if (event.key === 'Escape' && latestSearch.current.open && !isEscapeClaimed(event)) {
        claimEscape(event)
        setSearchOpen(false)
        searchTrigger.current?.focus()
      }
    }
    const away = (event: PointerEvent) => {
      if (latestSearch.current.open && !searchPopover.current?.contains(event.target as Node) && !searchTrigger.current?.contains(event.target as Node)) setSearchOpen(false)
    }
    const blur = () => setSearchOpen(false)
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('blur', blur)
    }
  }, [])
  const selected = resolveLeftTab(props.selected, props.documentOpen, props.previewOpen)
  const labels: Record<LeftTab, string> = { projects: 'Projects', conversation: 'Conversation', contents: 'Contents' }
  const counts: Partial<Record<LeftTab, number | undefined>> = { conversation: props.conversationCount }
  const tabs = leftTabs(props.documentOpen, props.previewOpen).map((id) => ({ id, label: labels[id], ...(counts[id] ? { count: counts[id] } : {}) }))
  return (
    <aside className="island navigation-rail" aria-label="Document navigation" data-panel={selected}>
      <AmbientDecor variant="explorer" />
      <div className="navigation-header">
        <button ref={searchTrigger} type="button" className="projects-search-trigger" aria-label="Search threads" title={props.projectQuery ? `Search threads: ${props.projectQuery}` : 'Search threads'} aria-expanded={searchOpen} aria-controls={searchOpen ? 'projects-search-popover' : undefined} data-filtered={Boolean(props.projectQuery.trim())} onClick={() => { if (!searchOpen) props.onSelect('projects'); setSearchOpen(!searchOpen) }}><SearchIcon /></button>
        <RailTabs label="Document navigation" idPrefix="navigation" selected={selected} onSelect={(tab) => { setSearchOpen(false); props.onSelect(tab) }} tabs={tabs} />
        {searchOpen && <div ref={searchPopover} id="projects-search-popover" className="projects-search-popover" role="search" aria-label="Conversations">
          <input ref={searchInput} type="search" aria-label="Search threads" placeholder="Search threads" value={props.projectQuery} onChange={(event) => props.onProjectQueryChange(event.target.value)} />
          <button type="button" aria-label="Close search" title="Close search" onClick={() => { setSearchOpen(false); searchTrigger.current?.focus() }}><XIcon /></button>
        </div>}
      </div>
      <section role="tabpanel" id="navigation-panel-projects" aria-labelledby="navigation-tab-projects" hidden={selected !== 'projects'}>
        {props.projects}
      </section>
      {(props.documentOpen || props.previewOpen) && (
        <section role="tabpanel" id="navigation-panel-conversation" aria-labelledby="navigation-tab-conversation" hidden={selected !== 'conversation'}>
          {props.conversation}
        </section>
      )}
      {props.documentOpen && !props.previewOpen && (
        <section role="tabpanel" id="navigation-panel-contents" aria-labelledby="navigation-tab-contents" hidden={selected !== 'contents'}>
          {props.contents}
        </section>
      )}
    </aside>
  )
}
