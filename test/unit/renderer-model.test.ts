import { describe, expect, it } from 'vitest'
import type { DocumentView, HunkView } from '../../src/shared/contracts'
import { activeAnnotations, annotationCounts, bannerFor, changeGroups, clampPanelSize, clampThemePanel, currentAnnotation, EMPTY_VIEW, explorerTree, hasResolvedAnnotations, hasUnsavedCounted, hunkAction, hunkAuthor, hunkSnippet, pendingCount, previewTabIndex, rendererThemeStyle, saveStateSentence, spellingForSelection } from '../../src/renderer/model'
import { THEME_KEYS } from '../../src/shared/theme-keys'
import { renderAmbient } from '../../src/renderer/components/AmbientDecor'

const hunk: HunkView = {
  id: 'h1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
  removed: ['before'], added: ['after'], status: 'pending', author: null,
  source: 'buffer', inline: true, saved: false
}

function document(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    path: '/tmp/plan.md', bufferPath: '/tmp/buffer.md', leadAgentId: null, content: '# Plan', sourceMode: false,
    sourceOnly: false, readOnly: false, dirty: false, deleted: false, invalidUtf8: false,
    lastSavedAt: null, historyStep: 0, pendingHunks: [], saves: [], annotations: [], attachments: [],
    canSend: false, conflicts: [], ...overrides
  }
}

describe('renderer model', () => {
  it('clamps all persisted panel sizes to the PRD ranges', () => {
    expect(clampPanelSize('explorerWidth', 50)).toBe(160)
    expect(clampPanelSize('explorerWidth', 900)).toBe(340)
    expect(clampPanelSize('rightRailWidth', 390.6)).toBe(391)
    expect(clampPanelSize('documentMeasure', 2000)).toBe(1600)
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
      '--surfaces-overlay-text': '#f4f3f6',
      '--people-you-text': '#f4f3f6',
      '--people-agent-4-text': '#241f31',
    })
    for (const filled of ['--surfaces-overlay', '--controls-primary', '--controls-selected', '--controls-positive', '--controls-warning', '--controls-danger', '--people-you', '--people-agent-1', '--people-agent-2', '--people-agent-3', '--people-agent-4', '--people-external']) {
      expect(style[`${filled}-text`], filled).toMatch(/^#[0-9a-f]{6}$/)
    }
    // Selection colors derive from the selected color mixed into the panel.
    expect(style['--selection-background']).toMatch(/^#[0-9a-f]{6}$/)
    expect(style['--selection-text']).toMatch(/^#[0-9a-f]{6}$/)
    expect((rendererThemeStyle(theme) as Record<string, string>)['--surfaces-overlay-text']).toBe('#241f31')
  })

  it('clamps the theme panel into the viewport and defaults it bottom-right', () => {
    const viewport = { width: 1440, height: 940 }
    expect(clampThemePanel({ x: -1, y: -1, width: 360, height: 560 }, viewport)).toEqual({ x: 1054, y: 356, width: 360, height: 560 })
    expect(clampThemePanel({ x: 5000, y: 5000, width: 100, height: 5000 }, viewport)).toEqual({ x: 1132, y: 8, width: 300, height: 924 })
  })

  it('prioritizes invalid UTF-8 banners over deleted-file warnings', () => {
    expect(bannerFor(document({ invalidUtf8: true, deleted: true }))?.tone).toBe('danger')
    expect(bannerFor(document({ deleted: true }))?.text).toContain('was deleted')
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
