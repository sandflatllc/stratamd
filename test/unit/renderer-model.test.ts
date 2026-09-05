import { describe, expect, it } from 'vitest'
import type { DocumentView, HunkView } from '../../src/shared/contracts'
import { activeAnnotations, activitySnapshot, agentActivity, agentActivityMessage, annotationCounts, attachmentStatusLine, bannerFor, bulkRevertGroups, changeGroups, clampPanelSize, clampThemePanel, currentAnnotation, cycleTab, EMPTY_VIEW, explorerTree, filteredAnnotations, hasResolvedAnnotations, hasUnsavedCounted, hunkAction, hunkAuthor, hunkSnippet, leftWindowWidth, nextReviewTarget, pendingCount, previewTabIndex, rendererThemeStyle, reviewTargets, saveStateSentence, shouldAdoptPushed, sideWindowCeiling, spellingForSelection, tabsToClose, threadTargets, threadTime, timeAgoShort, projectForPath } from '../../src/renderer/model'
import { INFO_TOAST_MS, nextToast, toastLifetime } from '../../src/renderer/toasts'
import { formatKeys, shortcutGroups } from '../../src/renderer/shortcuts'
import { menuKeyTarget } from '../../src/renderer/components/PathContextMenu'
import { THEME_KEYS } from '../../src/shared/theme-keys'
import { renderAmbient } from '../../src/renderer/components/AmbientDecor'

const hunk: HunkView = {
  id: 'h1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
  removed: ['before'], added: ['after'], status: 'pending', author: null,
  source: 'buffer', inline: true, saved: false, changedAt: 0
}

function document(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    path: '/tmp/plan.md', bufferPath: '/tmp/buffer.md', leadAgentId: null, content: '# Plan', sourceMode: false,
    reading: { formatVersion: 4, navigationTab: 'contents', reviewTab: 'changes', walkthrough: { active: false, level: 'h2', current: null, excluded: [], markers: [] }, tables: [], foldedHeadings: [] },
    sourceOnly: false, readOnly: false, dirty: false, deleted: false, invalidUtf8: false,
    lastSavedAt: null, historyStep: 0, pendingHunks: [], saves: [], annotations: [], drafts: [], attachments: [], recipients: [],
    canSend: false, conflicts: [], problems: [], ...overrides
  }
}

describe('renderer model', () => {
  it('clamps all persisted panel sizes to the PRD ranges', () => {
    expect(clampPanelSize('explorerWidth', 50)).toBe(160)
    expect(clampPanelSize('explorerWidth', 900)).toBe(900)
    expect(clampPanelSize('rightRailWidth', 390.6)).toBe(391)
    expect(clampPanelSize('upperReviewHeight', 9_000)).toBe(954)
    expect(clampPanelSize('documentMeasure', 2000)).toBe(1600)
  })

  it('gives the left window one width for every tab, with no fixed ceiling', () => {
    const sizes = { ...EMPTY_VIEW.settings.panelSizes, explorerWidth: 212, rightRailWidth: 300, threadPanel: { width: 780, height: -1 } }
    expect(leftWindowWidth(sizes, 1440)).toBe(212)
    // The legacy Conversation width is ignored: one width serves Projects, Conversation, and Contents (decided 2026-09-04).
    expect(leftWindowWidth({ ...sizes, explorerWidth: 212 }, 1440)).toBe(212)
    expect(leftWindowWidth({ ...sizes, explorerWidth: 100 }, 1440)).toBe(160)
    expect(leftWindowWidth({ ...sizes, explorerWidth: 1500 }, 2400)).toBe(1500)
    expect(clampPanelSize('explorerWidth', 1500)).toBe(1500)
    // The window is the only limit: a side window yields so the editor keeps its floor,
    // and the side window's own minimum wins when the window cannot fit both.
    expect(sideWindowCeiling(160, 1440, 300)).toBe(812)
    expect(leftWindowWidth({ ...sizes, explorerWidth: 900 }, 960)).toBe(332)
    expect(sideWindowCeiling(330, 600, 300)).toBe(330)
  })

  it('labels review hunks in plain words without inventing attribution', () => {
    expect(hunkAuthor(hunk)).toBe('someone else')
    expect(hunkAction(hunk)).toBe('changes')
    expect(hunkAction({ ...hunk, oldLines: 0, removed: [] })).toBe('adds')
    expect(hunkAction({ ...hunk, newLines: 0, added: [] })).toBe('removes')
    expect(hunkSnippet(hunk)).toEqual([
      { kind: 'removed', text: 'before' },
      { kind: 'added', text: 'after' },
    ])
    expect(hunkSnippet({ ...hunk, removed: [], added: ['one', 'two', 'three'] })).toEqual([
      { kind: 'added', text: 'one' },
      { kind: 'added', text: 'two' },
    ])
  })

  it('groups changes by save state and counts open and removed-text annotations', () => {
    const savedHunk = { ...hunk, id: 'h2', saved: true }
    const suggestion = { id: 'a1', seq: 1, kind: 'suggestion' as const, status: 'open' as const, author: 'user' as const, quote: 'before', text: 'after', line: 1, from: 0, to: 6, replies: [] }
    const orphan = { id: 'a2', seq: 2, kind: 'comment' as const, status: 'orphaned' as const, author: 'user' as const, quote: 'gone', text: 'note', line: null, from: null, to: null, replies: [] }
    const view = document({ pendingHunks: [hunk, savedHunk], annotations: [suggestion, orphan] })
    expect(changeGroups(view)).toEqual({ proposed: [suggestion], unsaved: [hunk], saved: [savedHunk] })
    expect(hasUnsavedCounted(view)).toBe(true)
    expect(hasUnsavedCounted(document({ pendingHunks: [savedHunk] }))).toBe(false)
    expect(annotationCounts(view)).toEqual({ open: 1, removedText: 1 })
  })

  it('counts pending direct edits and open suggestions', () => {
    const view = document({
      pendingHunks: [hunk],
      annotations: [{ id: 'a1', seq: 1, kind: 'suggestion', status: 'open', author: 'user', quote: 'before', text: 'after', line: 1, from: 0, to: 6, replies: [] }]
    })
    expect(pendingCount(view)).toBe(2)
  })

  it('keeps resolved annotations out of the default panel while detecting the clear action', () => {
    const resolved = { id: 'a1', seq: 1, kind: 'comment' as const, status: 'resolved' as const, author: 'user' as const, quote: 'x', text: 'done', line: 1, from: 0, to: 1, replies: [] }
    const view = document({ annotations: [resolved] })
    expect(activeAnnotations(view)).toEqual([])
    expect(hasResolvedAnnotations(view)).toBe(true)
  })

  it('filters unresolved annotation kinds and keeps every resolved kind together', () => {
    const base = { seq: 1, status: 'open' as const, author: 'user' as const, quote: 'x', text: 'note', line: 1, from: 0, to: 1, replies: [] }
    const decision = { ...base, id: 'd', kind: 'decision' as const, anchor: 'document' as const, quote: '', from: null, to: null, decision: { options: ['A', 'B'], answers: [] } }
    const question = { ...base, id: 'q', kind: 'question' as const }
    const resolved = { ...base, id: 'r', kind: 'comment' as const, status: 'resolved' as const }
    const view = document({ annotations: [decision, question, resolved] })
    expect(filteredAnnotations(view, 'all').map((item) => item.id)).toEqual(['d', 'q'])
    expect(filteredAnnotations(view, 'decisions')).toEqual([decision])
    expect(filteredAnnotations(view, 'questions')).toEqual([question])
    expect(filteredAnnotations(view, 'comments')).toEqual([])
    expect(filteredAnnotations(view, 'resolved')).toEqual([resolved])
  })

  it('reads an open thread from the latest document view', () => {
    const selected = { id: 'a1', seq: 1, kind: 'comment' as const, status: 'open' as const, author: 'user' as const, quote: 'x', text: 'note', line: 1, from: 0, to: 1, replies: [] }
    const updated = { ...selected, replies: [{ id: 'r1', author: 'user' as const, text: 'reply', createdAt: 1 }] }
    expect(currentAnnotation(document({ annotations: [updated] }), selected)).toBe(updated)
    expect(currentAnnotation(document(), selected)).toBeNull()
  })

  it('moves recipient preview tabs with horizontal tablist keys', () => {
    expect(previewTabIndex(0, 2, 'ArrowRight')).toBe(1)
    expect(previewTabIndex(0, 2, 'ArrowLeft')).toBe(1)
    expect(previewTabIndex(1, 2, 'Home')).toBe(0)
    expect(previewTabIndex(0, 2, 'End')).toBe(1)
    expect(previewTabIndex(0, 2, 'Enter')).toBeNull()
  })

  it('maps every theme key to a renderer variable and derives a readable foreground for every filled surface', () => {
    const theme = EMPTY_VIEW.settings.theme
    const style = rendererThemeStyle({
      ...theme,
      active: { ...theme.active, values: { ...theme.active.values, 'fonts.text': 'Nunito', 'people.you': '#102030', 'people.agent-4': '#d0e0f0', 'surfaces.overlay': '#101010' } },
    }) as Record<string, string | number>
    for (const entry of THEME_KEYS) expect(style).toHaveProperty(entry.variable)
    expect(style).toMatchObject({
      '--font-text': '"Nunito"',
      '--people-you': '#102030',
      '--people-agent-4': '#d0e0f0',
      // Dark surfaces get light text and light surfaces dark text, per value.
      '--surfaces-overlay-text': '#fbfaff',
      '--people-you-text': '#fbfaff',
      '--people-agent-4-text': '#14101f',
    })
    for (const filled of ['--surfaces-overlay', '--controls-primary', '--controls-selected', '--controls-positive', '--controls-warning', '--controls-danger', '--people-you', '--people-agent-1', '--people-agent-2', '--people-agent-3', '--people-agent-4', '--people-external']) {
      expect(style[`${filled}-text`], filled).toMatch(/^#[0-9a-f]{6}$/)
    }
    // Selection colors derive from the selected color mixed into the panel.
    expect(style['--selection-background']).toMatch(/^#[0-9a-f]{6}$/)
    expect(style['--selection-text']).toMatch(/^#[0-9a-f]{6}$/)
    expect((rendererThemeStyle(theme) as Record<string, string>)['--surfaces-overlay-text']).toBe('#14101f')
  })

  it('clamps the theme panel into the viewport and defaults it bottom-right', () => {
    const viewport = { width: 1440, height: 940 }
    expect(clampThemePanel({ x: -1, y: -1, width: 360, height: 560 }, viewport)).toEqual({ x: 1054, y: 356, width: 360, height: 560 })
    expect(clampThemePanel({ x: 5000, y: 5000, width: 100, height: 5000 }, viewport)).toEqual({ x: 1132, y: 8, width: 300, height: 924 })
  })

  it('prioritizes invalid UTF-8 banners over deleted-file warnings', () => {
    expect(bannerFor(document({ invalidUtf8: true, deleted: true }))?.tone).toBe('danger')
    expect(bannerFor(document({ deleted: true }))?.text).toContain('was deleted')
    expect(bannerFor(document({ problems: ['mirror'] }))?.text).toContain('copy agents read')
    expect(bannerFor(document({ problems: ['watch'] }))?.text).toContain('changes made outside')
    expect(bannerFor(document({ problems: ['persist'] }))?.text).toContain('review notes')
    expect(bannerFor(document({ deleted: true, problems: ['mirror'] }))?.text).toContain('was deleted')
  })

  it('states the save state in one plain sentence without negative ages', () => {
    const now = 10_000_000
    expect(saveStateSentence(false, now + 2_000, now)).toBe('Everything saved · just now')
    expect(saveStateSentence(false, now - 185_000, now)).toBe('Everything saved · 3 minutes ago')
    expect(saveStateSentence(true, now - 185_000, now)).toBe('Unsaved changes · last saved 3 minutes ago')
    expect(saveStateSentence(true, null, now)).toBe('Unsaved changes')
    expect(saveStateSentence(false, null, now)).toBe('Everything saved')
  })

  it('keeps ambient motion on by default and retains every handoff decor layer for the built-in window style', () => {
    expect(EMPTY_VIEW.settings.animatedBackground).toBe(true)
    const counts = (island: 'explorer' | 'editor' | 'changes' | 'annotations' | 'agents') => {
      const elements = renderAmbient('glow-orbs', 'card', island)
      return { glows: elements.filter((element) => element.kind === 'glow').length, motes: elements.filter((element) => element.kind === 'dot').length }
    }
    expect({ explorer: counts('explorer'), editor: counts('editor'), changes: counts('changes'), annotations: counts('annotations'), agents: counts('agents') }).toEqual({
      explorer: { glows: 2, motes: 1 },
      editor: { glows: 3, motes: 3 },
      changes: { glows: 1, motes: 1 },
      annotations: { glows: 1, motes: 1 },
      agents: { glows: 1, motes: 1 }
    })
  })

  it('keeps the on-disk subfolder layout in the explorer tree', () => {
    const file = (relativePath: string) => ({
      path: `/w/${relativePath}`, name: relativePath.split('/').at(-1)!, relativePath,
      folder: '/w', missing: false, pendingCount: 0,
    })
    const tree = explorerTree({ path: '/w', name: 'w', files: [
      file('docs/README.md'), file('zeta.md'), file('core/README.md'), file('core/deep/notes.md'), file('alpha.md'),
    ] })

    expect(tree.files.map((entry) => entry.name)).toEqual(['alpha.md', 'zeta.md'])
    expect(tree.folders.map((folder) => folder.name)).toEqual(['core', 'docs'])
    const core = tree.folders[0]!
    expect(core.path).toBe('/w/core')
    expect(core.files.map((entry) => entry.path)).toEqual(['/w/core/README.md'])
    expect(core.folders[0]).toMatchObject({ name: 'deep', path: '/w/core/deep' })
    expect(core.folders[0]?.files[0]?.name).toBe('notes.md')
    expect(tree.folders[1]?.files[0]?.path).toBe('/w/docs/README.md')
  })
})

describe('spellingForSelection', () => {
  const spelling = { word: 'occured', suggestions: ['occurred', 'occulted'] }

  it('attaches only when the selection is exactly the misspelled word', () => {
    expect(spellingForSelection(spelling, { quote: 'occured' })).toBe(spelling)
  })

  it('hides the column for section highlights and mismatched words', () => {
    expect(spellingForSelection(spelling, { quote: 'beta occured' })).toBeNull()
    expect(spellingForSelection(spelling, { quote: 'gamma' })).toBeNull()
  })

  it('shows nothing without a payload or without a selection', () => {
    expect(spellingForSelection(null, { quote: 'occured' })).toBeNull()
    expect(spellingForSelection(spelling, null)).toBeNull()
  })
})

describe('shell keyboard helpers (PRD §6.1, §6.9)', () => {
  const tabs = [
    { path: '/a.md', name: 'a.md', pendingCount: 0, active: false, dirty: false },
    { path: '/b.md', name: 'b.md', pendingCount: 0, active: true, dirty: false },
    { path: '/c.md', name: 'c.md', pendingCount: 0, active: false, dirty: false },
  ]

  it('cycles tabs in both directions with wrap-around and nothing to cycle alone', () => {
    expect(cycleTab(tabs, 1)?.path).toBe('/c.md')
    expect(cycleTab(tabs, -1)?.path).toBe('/a.md')
    expect(cycleTab([tabs[2]!, tabs[0]!, { ...tabs[1]!, active: false }], 1)?.path).toBe('/a.md')
    expect(cycleTab([tabs[1]!], 1)).toBeNull()
    expect(cycleTab([], -1)).toBeNull()
  })

  it('orders pending hunks and open suggestions by line and steps through them with wrap-around', () => {
    const view = document({
      pendingHunks: [{ ...hunk, id: 'h9', newStart: 9 }, { ...hunk, id: 'h3', newStart: 3 }],
      annotations: [
        { id: 's5', seq: 1, kind: 'suggestion', status: 'open', author: 'user', quote: 'q', text: 'r', line: 5, from: 0, to: 1, replies: [] },
        { id: 's3', seq: 2, kind: 'suggestion', status: 'open', author: 'user', quote: 'q', text: 'r', line: 3, from: 0, to: 1, replies: [] },
        { id: 'resolved', seq: 3, kind: 'suggestion', status: 'resolved', author: 'user', quote: 'q', text: 'r', line: 1, from: 0, to: 1, replies: [] },
        { id: 'comment', seq: 4, kind: 'comment', status: 'open', author: 'user', quote: 'q', text: 'r', line: 1, from: 0, to: 1, replies: [] },
        { id: 'orphan', seq: 5, kind: 'suggestion', status: 'orphaned', author: 'user', quote: 'q', text: 'r', line: null, from: null, to: null, replies: [] },
      ],
    })
    const targets = reviewTargets(view)
    expect(targets.map((target) => target.id)).toEqual(['h3', 's3', 's5', 'h9'])
    expect(nextReviewTarget(targets, null, 1)?.id).toBe('h3')
    expect(nextReviewTarget(targets, null, -1)?.id).toBe('h9')
    expect(nextReviewTarget(targets, 's5', 1)?.id).toBe('h9')
    expect(nextReviewTarget(targets, 'h9', 1)?.id).toBe('h3')
    expect(nextReviewTarget(targets, 'h3', -1)?.id).toBe('h9')
    expect(nextReviewTarget(targets, 'gone', 1)?.id).toBe('h3')
    expect(nextReviewTarget([], null, 1)).toBeNull()
  })

  it('offers a bulk revert only to authors with more than one pending change', () => {
    const agent = { id: 'agent-a', name: 'Agent A', color: 'grape' as const }
    const view = document({ pendingHunks: [
      { ...hunk, id: 'e1' },
      { ...hunk, id: 'a1', author: agent },
      { ...hunk, id: 'a2', author: agent, status: 'mixed' },
    ] })
    const groups = bulkRevertGroups(view)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'agent-a', name: 'Agent A' })
    expect(groups[0]!.hunks.map((item) => item.id)).toEqual(['a1', 'a2'])
    expect(bulkRevertGroups(document({ pendingHunks: [{ ...hunk, id: 'e1' }, { ...hunk, id: 'e2' }] }))[0]).toMatchObject({ name: 'someone else' })
  })

  it('shows a thread time only when the record carries one', () => {
    const now = 1_000_000
    expect(threadTime(undefined, now)).toBe('')
    expect(threadTime(0, now)).toBe('')
    expect(threadTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
  })

})

describe('toast policy (PRD §6.9)', () => {
  it('lets an error outlive its timer and stops a success from painting over it', () => {
    const error = nextToast(null, { message: 'Save failed', tone: 'error' })!
    expect(error.tone).toBe('error')
    expect(toastLifetime(error)).toBeNull()

    expect(nextToast(error, { message: 'Saved.', tone: 'info' })).toBe(error)

    const newer = nextToast(error, { message: 'Send failed', tone: 'error' })!
    expect(newer.message).toBe('Send failed')
    expect(newer.id).not.toBe(error.id)
  })

  it('keeps successes short-lived and replaces one success with the next', () => {
    const first = nextToast(null, { message: 'Saved.', tone: 'info' })!
    expect(toastLifetime(first)).toBe(2800)
    const second = nextToast(first, { message: 'Kept.', tone: 'info' })!
    expect(second.message).toBe('Kept.')
    expect(second.id).not.toBe(first.id)
    expect(nextToast(second, { message: '', tone: 'error' })).toBe(second)
    expect(nextToast(first, { message: 'Oops', tone: 'error' })?.tone).toBe('error')
  })
})

describe('usability round 2 renderer helpers', () => {
  const claude = { id: 'ag_1', name: 'Claude', color: 'grape' as const }
  const agentHunk = { ...hunk, id: 'h-agent', author: claude, newStart: 12 }
  const agentSuggestion = { id: 's1', seq: 3, kind: 'suggestion' as const, status: 'open' as const, author: claude, quote: 'old', text: 'new', line: 4, from: 0, to: 3, replies: [] }

  it('notices new agent changes and suggestions since the last push, never the user\'s own', () => {
    const before = document({ pendingHunks: [hunk] })
    const after = document({ pendingHunks: [hunk, agentHunk], annotations: [agentSuggestion, { ...agentSuggestion, id: 's-user', author: 'user' as const }] })
    expect(agentActivity(null, after)).toBeNull()
    expect(agentActivity(activitySnapshot(before), before)).toBeNull()
    const activity = agentActivity(activitySnapshot(before), after)
    expect(activity).toEqual({ authors: ['Claude'], changes: 1, suggestions: 1, target: { kind: 'suggestion', id: 's1', line: 4 } })
    expect(agentActivityMessage(activity!)).toBe('Claude changed 1 passage and suggested 1 change')
    expect(agentActivityMessage({ authors: ['Claude', 'GPT'], changes: 3, suggestions: 0, target: activity!.target })).toBe('Claude and GPT changed 3 passages')
    // An external hunk with no author is not agent activity.
    expect(agentActivity(activitySnapshot(before), document({ pendingHunks: [hunk, { ...hunk, id: 'h-ext' }] }))).toBeNull()
  })

  it('steps through open comments and questions in document order', () => {
    const view = document({ annotations: [
      { ...agentSuggestion, id: 'q', kind: 'question', line: 9 },
      { ...agentSuggestion, id: 'c', kind: 'comment', line: 2 },
      { ...agentSuggestion, id: 'resolved', kind: 'comment', status: 'resolved', line: 1 },
      agentSuggestion,
    ] })
    expect(threadTargets(view).map((target) => target.id)).toEqual(['c', 'q'])
    expect(nextReviewTarget(threadTargets(view), 'q', 1)?.id).toBe('c')
  })

  it('adopts a pushed panel size or zoom only when it differs from the last commit', () => {
    const sizes = EMPTY_VIEW.settings.panelSizes
    expect(shouldAdoptPushed(sizes, null)).toBe(true)
    expect(shouldAdoptPushed(sizes, { ...sizes })).toBe(false)
    expect(shouldAdoptPushed({ ...sizes, explorerWidth: 300 }, sizes)).toBe(true)
  })


  it('closes saved tabs in bulk and counts the dirty ones it leaves open', () => {
    const tabs = [
      { path: '/one', name: 'one', pendingCount: 0, active: true, dirty: false },
      { path: '/two', name: 'two', pendingCount: 0, active: false, dirty: true },
      { path: '/three', name: 'three', pendingCount: 0, active: false, dirty: false },
    ]
    expect(tabsToClose(tabs, 'others', '/one')).toEqual({ close: [tabs[2]], keptDirty: 1 })
    expect(tabsToClose(tabs, 'all', '/one')).toEqual({ close: [tabs[0], tabs[2]], keptDirty: 1 })
    expect(tabsToClose(tabs, 'saved', '/one')).toEqual({ close: [tabs[0], tabs[2]], keptDirty: 0 })
  })

  it('gives a toast with a button more time and carries the button through', () => {
    const run = () => undefined
    const toast = nextToast(null, { message: 'Claude changed 3 passages', tone: 'info', action: { label: 'Show', run } })
    expect(toast?.action?.label).toBe('Show')
    expect(toastLifetime(toast!)).toBe(INFO_TOAST_MS * 3)
    expect(toastLifetime(nextToast(null, { message: 'Saved.', tone: 'info' })!)).toBe(INFO_TOAST_MS)
  })

  it('describes the editor keymap in plain words with platform key names', () => {
    expect(formatKeys('Shift-Mod-c', false)).toBe('Ctrl+Shift+C')
    expect(formatKeys('Mod-Enter', true)).toBe('Cmd+Enter')
    const groups = shortcutGroups(undefined, false)
    const writing = groups.find((group) => group.title === 'Writing')!
    expect(writing.entries).toEqual(expect.arrayContaining([
      { keys: 'Ctrl+B', action: 'Bold' },
      { keys: 'Ctrl+K', action: 'Add or edit a link' },
      { keys: 'Ctrl+Shift+8', action: 'Bullet list' },
      { keys: 'Ctrl+/', action: 'Switch between visual and source view' },
    ]))
    // Base bindings without a description (Backspace, Delete…) stay out of the sheet.
    expect(writing.entries.some((entry) => entry.keys === 'Backspace')).toBe(false)
    expect(groups.flatMap((group) => group.entries).some((entry) => entry.keys.startsWith('F8'))).toBe(true)
    expect(shortcutGroups(['Mod-b'], false).find((group) => group.title === 'Writing')!.entries).toEqual([{ keys: 'Ctrl+B', action: 'Bold' }])
  })

  it('walks menus with the arrow keys', () => {
    const items = [{}, {}, {}] as unknown as HTMLElement[]
    expect(menuKeyTarget(items, 0, 'ArrowDown')).toBe(1)
    expect(menuKeyTarget(items, 0, 'ArrowUp')).toBe(2)
    expect(menuKeyTarget(items, 1, 'End')).toBe(2)
    expect(menuKeyTarget(items, 1, 'Tab')).toBeNull()
  })
})

describe('rail relative time and attachment status (plan 5.5, 5.6)', () => {
  const MINUTE = 60_000

  it('renders the compact relative time the rail rows use', () => {
    expect(timeAgoShort(0)).toBe('just now')
    expect(timeAgoShort(59_000)).toBe('just now')
    expect(timeAgoShort(3 * MINUTE)).toBe('3 min ago')
    expect(timeAgoShort(2 * 60 * MINUTE)).toBe('2 h ago')
    expect(timeAgoShort(30 * 60 * MINUTE)).toBe('yesterday')
    expect(timeAgoShort(3 * 24 * 60 * MINUTE)).toBe('3 days ago')
    // A clock that runs ahead of the stamp never reads as the future.
    expect(timeAgoShort(-5_000)).toBe('just now')
  })

  it('finds the project whose workspace contains a document by path segments, preferring the deepest', () => {
    const engine = { projects: [
      { id: 'root', title: 'Root', workspaceRoot: '/work', threads: [] },
      { id: 'deep', title: 'Deep', workspaceRoot: '/work/docs/', threads: [] },
      { id: 'other', title: 'Other', workspaceRoot: '/workspace', threads: [] },
    ] }
    expect(projectForPath(engine, '/work/docs/plan.md')?.id).toBe('deep')
    expect(projectForPath(engine, '/work/plan.md')?.id).toBe('root')
    expect(projectForPath(engine, '/workshop/plan.md')).toBeNull()
    expect(projectForPath(engine, '/workspace/notes.md')?.id).toBe('other')
  })

  it('shows engine state and a pending delivery count', () => {
    expect(attachmentStatusLine({ state: 'running', queuedSendCount: 0 })).toBe('running')
    expect(attachmentStatusLine({ state: 'idle', queuedSendCount: 2 })).toBe('idle · 2 updates waiting for it')
    expect(attachmentStatusLine({ state: 'disconnected', queuedSendCount: 1 })).toBe('disconnected · 1 update waiting for it')
  })
})
