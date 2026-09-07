import { describe, expect, it } from 'vitest'
import { nextRegionLabel, revisionForReply, sendCapacity, visualBrief, visualCommentView, visualPlace, visualStatus, visualSummary, visualTitle, type VisualCommentRecord, type VisualRevision } from '../../src/core/visual-comments'
import { renderConversationDelivery } from '../../src/core/conversation-delivery'

const mark = { id: 'k1', kind: 'region' as const, label: 'Region 1', captureId: 'e_cap', rect: { x: 10, y: 20, width: 30, height: 40 }, found: null }
function revision(number: number, overrides: Partial<VisualRevision> = {}): VisualRevision {
  return { number, text: `Note ${number}`, marks: [mark], strokes: [], adjustments: [], destination: { threadId: 't1', engine: null }, captures: ['e_cap'], evidence: ['e_marked'], deliveryId: `d${number}`, sentAt: number, state: 'sent', replies: [], ...overrides }
}
function comment(overrides: Partial<VisualCommentRecord> = {}): VisualCommentRecord {
  return { id: 'v_1', projectId: 'p1', engine: null, anchor: { kind: 'image', name: 'shot.png' }, captures: [{ id: 'e_cap', width: 800, height: 600, markedId: 'e_marked', takenAt: 1 }], draft: null, revisions: [], createdAt: 1, updatedAt: 1, ...overrides }
}

describe('visual comment status (docs/plans/open/visual-review, phase 1)', () => {
  it('derives held, sending, failed, sent, ready, and done from the draft and the latest revision', () => {
    expect(visualStatus(comment({ draft: { text: '', marks: [], strokes: [], adjustments: [], destination: { threadId: 't1', engine: null }, updatedAt: 1 } }))).toBe('held')
    expect(visualStatus(comment())).toBe('held')
    expect(visualStatus(comment({ revisions: [revision(1, { state: 'sending' })] }))).toBe('sending')
    expect(visualStatus(comment({ revisions: [revision(1, { state: 'failed', error: 'offline' })] }))).toBe('failed')
    expect(visualStatus(comment({ revisions: [revision(1)] }))).toBe('sent')
    expect(visualStatus(comment({ revisions: [revision(1, { replies: [{ messageId: 'm', text: 'Done', ready: true, at: 2 }] })] }))).toBe('ready')
    expect(visualStatus(comment({ revisions: [revision(1, { replies: [{ messageId: 'm', text: 'Done', ready: true, at: 2 }], accepted: true })] }))).toBe('done')
  })

  it('lets a late reply to an earlier revision leave the card unchanged', () => {
    const record = comment({ revisions: [revision(1, { replies: [{ messageId: 'm', text: 'Fixed the first one', ready: true, at: 2 }] }), revision(2)] })
    expect(visualStatus(record)).toBe('sent')
    expect(revisionForReply(record, 1)?.number).toBe(1)
    expect(revisionForReply(record, undefined)).toBeNull()
    expect(revisionForReply(record, 3)).toBeNull()
  })

  it('names the place, the summary, and the title in plain words', () => {
    expect(visualPlace({ kind: 'image', name: 'shot.png' }, [{ width: 800, height: 600 }])).toBe('Pasted image · 800 × 600')
    expect(visualPlace({ kind: 'page', url: 'http://localhost:5173/clients', title: 'Clients', instance: 'tab-1', workingFolder: null, viewport: { width: 1200, height: 800, preset: null }, deviceScale: 1 }, [])).toBe('Clients · window size')
    expect(visualPlace({ kind: 'page', url: 'http://localhost:5173/clients', title: 'Clients', instance: 'tab-1', workingFolder: null, viewport: { width: 390, height: 844, preset: 'Phone' }, deviceScale: 3 }, [])).toBe('Clients · phone')
    expect(visualSummary({ marks: [{ found: true }, { found: true }], strokes: [{ tool: 'arrow' }], adjustments: [1, 2] })).toBe('2 things marked, all found ✓ · 1 arrow · 2 adjustments')
    expect(visualSummary({ marks: [{ found: null }], strokes: [{ tool: 'draw' }, { tool: 'draw' }], adjustments: [] })).toBe('1 thing marked · 2 drawings')
    expect(visualSummary({ marks: [{ found: true }, { found: false }], strokes: [], adjustments: [] })).toBe('2 things marked, 1 of 2 found')
    expect(visualTitle({ text: 'Header labels drift', marks: [{ label: 'Table header' }, { label: 'New client button' }] })).toBe('Table header + New client button')
    expect(visualTitle({ text: 'Header labels do not line up with the cells under them, and the button floats above', marks: [] })).toBe('Header labels do not line up with the cells under them, a…')
    expect(nextRegionLabel([{ kind: 'region', label: 'Region 1' }, { kind: 'element', label: 'Save' }])).toBe('Region 2')
  })
})

describe('send capacity', () => {
  it('says what the send carries and refuses over capacity by name without trimming', () => {
    expect(sendCapacity({ files: 3, visualImages: 1, visualComments: 1, contextFile: true }).line).toBe('Send carries 3 files, 1 marked screenshot, and the context file · 5 of 8')
    expect(sendCapacity({ files: 0, visualImages: 2, visualComments: 2, contextFile: true }).line).toBe('Send carries 2 marked screenshots from 2 visual comments and the context file · 3 of 8')
    expect(sendCapacity({ files: 0, visualImages: 0, visualComments: 0, contextFile: false }).line).toBe('Send carries nothing · 0 of 8')
    const over = sendCapacity({ files: 3, visualImages: 5, visualComments: 2, contextFile: true })
    expect(over.total).toBe(9)
    expect(over.refusal).toBe('That send would carry 9 attachments, 1 over the limit of 8: 3 files, 5 marked screenshots from 2 visual comments, and the context file. Remove a file, or send a visual comment on its own first.')
    expect(sendCapacity({ files: 0, visualImages: 9, visualComments: 3, contextFile: true }).refusal).toContain('Send fewer visual comments at once.')
  })
})

describe('the brief and the view', () => {
  it('carries marks, strokes, adjustments, and the capture names into the context file', () => {
    const record = comment({ anchor: { kind: 'image', name: 'shot.png' } })
    const frozen = revision(1, { strokes: [{ id: 's1', tool: 'arrow', captureId: 'e_cap', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }], adjustments: [{ markId: 'k1', property: 'font-size', value: '18px', label: 'Text size · slightly larger' }], marks: [{ ...mark, identity: { role: 'button', name: 'Save', selector: 'button.save' } }] })
    const brief = visualBrief(record, frozen, new Map([['e_cap', 'visual-1-r1-1.png']]))
    expect(brief).toMatchObject({ id: 'v_1', revision: 1, text: 'Note 1', place: 'Pasted image · 800 × 600', captures: [{ name: 'visual-1-r1-1.png', width: 800, height: 600 }] })
    expect(brief.marks[0]).toMatchObject({ label: 'Region 1', capture: 'visual-1-r1-1.png', rect: mark.rect, role: 'button', name: 'Save', selector: 'button.save' })
    expect(brief.strokes).toEqual([{ tool: 'arrow', capture: 'visual-1-r1-1.png', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }])
    expect(brief.adjustments).toEqual([{ mark: 'k1', property: 'font-size', value: '18px' }])
    const rendered = renderConversationDelivery({ deliveryId: 'd1', threadId: 't1', annotations: [], replies: [], blocks: [], outcomes: [], visual: [brief] })
    expect(rendered).toContain('## Visual comments')
    expect(rendered).not.toContain('"ready":true')
    expect(rendered).not.toContain('Answer owner passage feedback')
    expect(rendered).not.toContain('Do the requested change')
    expect(rendered).toContain('visual-1-r1-1.png')
  })

  it('keeps mark identity available for editing and names the status in plain words', () => {
    const record = comment({ revisions: [revision(1, { marks: [{ ...mark, identity: { selector: 'button.save' } }], replies: [{ messageId: 'm', text: 'Moved it', ready: true, at: 3 }] })] })
    const view = visualCommentView(record, { captureUrl: (id) => `strata-visual://evidence/${id}`, threadTitle: () => 'Clients table review' })
    expect(view.status).toBe('ready')
    expect(view.statusLabel).toBe('ready for review')
    expect(view.thumbnail).toBe('strata-visual://evidence/e_marked')
    expect(view.revisions[0]!.destination).toEqual({ threadId: 't1', threadTitle: 'Clients table review' })
    expect(view.revisions[0]!.marks[0]!.identity?.selector).toBe('button.save')
    expect(view.summary).toBe('1 thing marked')
  })
})
