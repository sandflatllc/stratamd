import type { ReactNode } from 'react'
import type { EditorHeading } from '../../editor/headings'
import type { NavigationTab, WalkthroughAction, WalkthroughState } from '../../shared/contracts'
import { AmbientDecor } from './AmbientDecor'
import { Contents } from './Contents'
import { RailTabs } from './RailTabs'

interface NavigationRailProps {
  selected: NavigationTab
  files: ReactNode
  headings: readonly EditorHeading[]
  activeHeadingId: string | null
  walkthrough: WalkthroughState
  onSelect(tab: NavigationTab): void
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
      ]} />
      <section role="tabpanel" id="navigation-panel-files" aria-labelledby="navigation-tab-files" hidden={props.selected !== 'files'}>
        {props.files}
      </section>
      <section role="tabpanel" id="navigation-panel-contents" aria-labelledby="navigation-tab-contents" hidden={props.selected !== 'contents'}>
        <Contents headings={props.headings} activeId={props.activeHeadingId} walkthrough={props.walkthrough} onJump={props.onJumpHeading} onWalkthrough={props.onWalkthrough} />
      </section>
    </aside>
  )
}
