import type { ReactNode } from 'react'
import type { EditorHeading } from '../../editor/headings'
import type { NavigationTab, WalkthroughAction, WalkthroughState } from '../../shared/contracts'
import { AmbientDecor } from './AmbientDecor'
import { Contents } from './Contents'
import { RailTabs } from './RailTabs'

/** The left window's tabs: the two persisted navigation tabs plus the session-only Thread tab (PRD §6.9). */
export type LeftTab = NavigationTab | 'thread'

interface NavigationRailProps {
  selected: LeftTab
  files: ReactNode
  /** The open thread, or the Thread tab's empty state. */
  thread: ReactNode
  headings: readonly EditorHeading[]
  activeHeadingId: string | null
  walkthrough: WalkthroughState
  /** The live Markdown, for the walkthrough card's section preview. */
  content: string
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
        { id: 'thread', label: 'Thread' },
      ]} />
      <section role="tabpanel" id="navigation-panel-files" aria-labelledby="navigation-tab-files" hidden={props.selected !== 'files'}>
        {props.files}
      </section>
      <section role="tabpanel" id="navigation-panel-contents" aria-labelledby="navigation-tab-contents" hidden={props.selected !== 'contents'}>
        <Contents headings={props.headings} activeId={props.activeHeadingId} walkthrough={props.walkthrough} content={props.content} onJump={props.onJumpHeading} onWalkthrough={props.onWalkthrough} />
      </section>
      <section role="tabpanel" id="navigation-panel-thread" aria-labelledby="navigation-tab-thread" hidden={props.selected !== 'thread'}>
        {props.thread}
      </section>
    </aside>
  )
}
