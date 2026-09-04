import type { ReactNode } from 'react'
import type { EditorHeading } from '../../editor/headings'
import type { DraftView, NavigationTab, WalkthroughAction, WalkthroughState } from '../../shared/contracts'
import { AmbientDecor } from './AmbientDecor'
import { Contents } from './Contents'
import { RailTabs } from './RailTabs'

/** The left window's Files, Contents, Projects, and Conversation tabs. */
export type LeftTab = NavigationTab | 'projects' | 'conversation'

interface NavigationRailProps {
  selected: LeftTab
  files: ReactNode
  projects: ReactNode
  conversation: ReactNode
  headings: readonly EditorHeading[]
  drafts: readonly DraftView[]
  activeHeadingId: string | null
  walkthrough: WalkthroughState
  /** The live Markdown, for the walkthrough card's section preview. */
  content: string
  /** Badge counts for Projects and Conversation (§5.2 notifications); absent or zero shows none. */
  projectsCount?: number
  conversationCount?: number
  onSelect(tab: LeftTab): void
  onJumpHeading(id: string): void
  onWalkthrough(action: WalkthroughAction): void
}

export function NavigationRail(props: NavigationRailProps) {
  return (
    <aside className="island navigation-rail" aria-label="Document navigation">
      <AmbientDecor variant="explorer" />
      <RailTabs label="Document navigation" idPrefix="navigation" selected={props.selected} onSelect={props.onSelect} tabs={[
        { id: 'files', label: 'Files' },
        { id: 'contents', label: 'Contents' },
        { id: 'projects', label: 'Projects', ...(props.projectsCount ? { count: props.projectsCount } : {}) },
        { id: 'conversation', label: 'Conversation', ...(props.conversationCount ? { count: props.conversationCount } : {}) },
      ]} />
      <section role="tabpanel" id="navigation-panel-files" aria-labelledby="navigation-tab-files" hidden={props.selected !== 'files'}>
        {props.files}
      </section>
      <section role="tabpanel" id="navigation-panel-contents" aria-labelledby="navigation-tab-contents" hidden={props.selected !== 'contents'}>
        <Contents headings={props.headings} drafts={props.drafts} activeId={props.activeHeadingId} walkthrough={props.walkthrough} content={props.content} onJump={props.onJumpHeading} onWalkthrough={props.onWalkthrough} />
      </section>
      <section role="tabpanel" id="navigation-panel-projects" aria-labelledby="navigation-tab-projects" hidden={props.selected !== 'projects'}>
        {props.projects}
      </section>
      <section role="tabpanel" id="navigation-panel-conversation" aria-labelledby="navigation-tab-conversation" hidden={props.selected !== 'conversation'}>
        {props.conversation}
      </section>
    </aside>
  )
}
