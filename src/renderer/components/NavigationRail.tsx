import type { ReactNode } from 'react'
import type { NavigationTab } from '../../shared/contracts'
import { AmbientDecor } from './AmbientDecor'
import { RailTabs } from './RailTabs'

/** The left window's tabs: Projects always; Conversation and Contents while a document is in the center (decided 2026-09-04). */
export type LeftTab = NavigationTab

interface NavigationRailProps {
  selected: LeftTab
  /** True while a document shows in the center; Conversation and Contents apply only then. */
  documentOpen: boolean
  projects: ReactNode
  conversation: ReactNode
  contents: ReactNode
  /** Badge counts for Projects and Conversation (§5.2 notifications); absent or zero shows none. */
  projectsCount?: number
  conversationCount?: number
  onSelect(tab: LeftTab): void
}

/** Which tabs the left window offers, in order, for the current center content. */
export function leftTabs(documentOpen: boolean): LeftTab[] {
  return documentOpen ? ['projects', 'conversation', 'contents'] : ['projects']
}

/** The tab to show: the selection when it is offered, otherwise the first offered tab. */
export function resolveLeftTab(selected: LeftTab, documentOpen: boolean): LeftTab {
  const offered = leftTabs(documentOpen)
  return offered.includes(selected) ? selected : offered[0]!
}

export function NavigationRail(props: NavigationRailProps) {
  const selected = resolveLeftTab(props.selected, props.documentOpen)
  const labels: Record<LeftTab, string> = { projects: 'Projects', conversation: 'Conversation', contents: 'Contents' }
  const counts: Partial<Record<LeftTab, number | undefined>> = { projects: props.projectsCount, conversation: props.conversationCount }
  const tabs = leftTabs(props.documentOpen).map((id) => ({ id, label: labels[id], ...(counts[id] ? { count: counts[id] } : {}) }))
  return (
    <aside className="island navigation-rail" aria-label="Document navigation">
      <AmbientDecor variant="explorer" />
      <RailTabs label="Document navigation" idPrefix="navigation" selected={selected} onSelect={props.onSelect} tabs={tabs} />
      <section role="tabpanel" id="navigation-panel-projects" aria-labelledby="navigation-tab-projects" hidden={selected !== 'projects'}>
        {props.projects}
      </section>
      {props.documentOpen && (
        <section role="tabpanel" id="navigation-panel-conversation" aria-labelledby="navigation-tab-conversation" hidden={selected !== 'conversation'}>
          {props.conversation}
        </section>
      )}
      {props.documentOpen && (
        <section role="tabpanel" id="navigation-panel-contents" aria-labelledby="navigation-tab-contents" hidden={selected !== 'contents'}>
          {props.contents}
        </section>
      )}
    </aside>
  )
}
