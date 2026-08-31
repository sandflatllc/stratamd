import { describe, expect, it } from 'vitest'
import {
  createPayload,
  guardrailLine,
  MESSAGE_GUIDANCE_LINE,
  PAYLOAD_VERSION,
  writeOnlyLine,
  serializePayload,
  type PayloadEvent,
} from '../../src/core/payload'

const file = '/docs/plan.md'
const buffer = '/data/stratamd/buffer.md'

describe('payload v10', () => {
  it.each<PayloadEvent>(['initial', 'resync'])('starts %s text with the full write guardrail', (event) => {
    const payload = createPayload({ file, buffer, agent: 'ag_1', event })
    expect(payload.text.split('\n')[0]).toBe(
      "While attached, write only to the buffer file: /data/stratamd/buffer.md. The document /docs/plan.md is the user's to save.",
    )
    expect(payload.text.startsWith(guardrailLine(file, buffer))).toBe(true)
  })

  it.each<PayloadEvent>([
    'send', 'message', 'closed', 'timeout', 'superseded', 'state', 'changes',
  ])('starts %s text with only the buffer path the agent must write to', (event) => {
    const payload = createPayload({ file, buffer, agent: 'ag_1', event })
    expect(payload.text.split('\n')[0]).toBe('Write only to /data/stratamd/buffer.md.')
    expect(payload.text.startsWith(writeOnlyLine(buffer))).toBe(true)
    expect(payload.text.split('\n')[0]).not.toContain(file)
  })

  it('serializes documented fields as version 10 and omits absent fields', () => {
    const payload = createPayload({ file, buffer, agent: 'ag_1', event: 'timeout' })
    const json = JSON.parse(serializePayload(payload)) as Record<string, unknown>
    expect(json.version).toBe(PAYLOAD_VERSION)
    expect(json).not.toHaveProperty('deliveryId')
    expect(json).not.toHaveProperty('document')
    expect(json).not.toHaveProperty('notes')
  })

  it('renders a message as the sender line, the note, and the fixed guidance line', () => {
    const payload = createPayload({
      file,
      buffer,
      agent: 'ag_1',
      event: 'message',
      deliveryId: 'm_1',
      from: { agent: 'ag_2', name: 'GPT' },
      notes: ['Ready for your pass.'],
    })
    expect(payload.text).toBe([
      writeOnlyLine(buffer),
      'Message from GPT (ag_2):\nReady for your pass.',
      MESSAGE_GUIDANCE_LINE,
    ].join('\n\n'))
    expect(MESSAGE_GUIDANCE_LINE).toContain('stratamd state')
    expect(MESSAGE_GUIDANCE_LINE).toContain('stratamd changes')

    const json = JSON.parse(serializePayload(payload)) as Record<string, unknown>
    expect(json).toMatchObject({
      version: 11,
      event: 'message',
      deliveryId: 'm_1',
      from: { agent: 'ag_2', name: 'GPT' },
      notes: ['Ready for your pass.'],
    })
    expect(json).not.toHaveProperty('document')
    expect(json).not.toHaveProperty('segments')
  })

  it('renders the whole annotated document and open questions for initial payloads', () => {
    const payload = createPayload({
      file,
      buffer,
      agent: 'ag_1',
      event: 'initial',
      cursor: 2,
      document: 'A literal ⟦ bracket.\n\nWhy now?',
      annotations: [{
        id: 'a1', seq: 2, kind: 'question', author: 'user', agent: null,
        status: 'open', quote: 'Why now?', text: 'Can you justify this?', line: 3, replies: [],
      }],
    })

    expect(payload.text).toContain('A literal \\⟦ bracket.')
    expect(payload.text).toContain('⟦a1 question (user): Can you justify this?⟧Why now?⟦/a1⟧')
    expect(payload.text).toContain('Open questions:\n\n- a1 on line 3: Can you justify this?')
  })

  it('renders send content in notes, diffs, annotations, resolutions order', () => {
    const payload = createPayload({
      file,
      buffer,
      agent: 'ag_1',
      event: 'send',
      deliveryId: 'd_1',
      notes: ['Check the revised claim.'],
      segments: [{
        author: 'user',
        hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, removed: ['old'], added: ['new'] }],
      }],
      annotations: [{
        id: 'a1', seq: 4, kind: 'comment', author: 'agent', agent: 'ag_2',
        status: 'open', quote: 'new', text: 'Looks right.', line: 2, replies: [],
      }],
      resolved: [{ id: 'a0', seq: 5, kind: 'suggestion', resolution: 'accepted' }],
    }, { currentDocument: 'Title\n\nnew paragraph' })

    const notes = payload.text.indexOf('Notes:')
    const diff = payload.text.indexOf('Changes by user:')
    const annotation = payload.text.indexOf('Annotations:')
    const resolution = payload.text.indexOf('Resolutions:')
    expect(notes).toBeLessThan(diff)
    expect(diff).toBeLessThan(annotation)
    expect(annotation).toBeLessThan(resolution)
    expect(payload.text).toContain('@@ -2 +2 @@\n-old\n+new')
  })

  it('renders a reply to an earlier annotation as one line, after annotations and before resolutions', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', deliveryId: 'd_2', cursor: 9,
      replies: [{ id: 'r2', seq: 8, annotation: 'a1', author: 'user', text: 'Shorten the second ⟦paragraph⟧.' }],
      resolved: [{ id: 'a0', seq: 9, kind: 'comment', resolution: 'resolved' }],
    }, { currentDocument: 'hello world\n\nsecond paragraph' })

    expect(payload.text).toBe([
      writeOnlyLine(buffer),
      'Replies:\na1 ← user: Shorten the second \\⟦paragraph\\⟧.',
      'Resolutions:\na0 (comment) was resolved.',
    ].join('\n\n'))
    expect(payload.text).not.toContain('Annotations:')
    expect(payload.text).not.toContain('hello')
  })

  it('places replies after the surrounding paragraph, not inside it', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', cursor: 3,
      annotations: [{
        id: 'a1', seq: 3, kind: 'comment', author: 'user', agent: null,
        status: 'open', quote: 'hello', text: 'first', line: 1,
        replies: [{ id: 'r1', seq: 2, author: 'agent', agent: 'ag_2', text: 'answer' }],
      }],
    }, { currentDocument: 'hello world\n\nnext' })

    expect(payload.text).toContain('⟦a1 comment (user): first⟧hello⟦/a1⟧ world\n  ↳ ag_2: answer')
    expect(payload.text).not.toContain('next')
  })

  it('renders nested annotation highlights as a stack', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', document: 'abcdef',
      annotations: [
        { id: 'outer', seq: 1, kind: 'comment', author: 'user', agent: null, status: 'open', quote: 'bcde', text: 'outer', line: 1, replies: [] },
        { id: 'inner', seq: 2, kind: 'comment', author: 'user', agent: null, status: 'open', quote: 'cd', text: 'inner', line: 1, replies: [] },
      ],
    })
    expect(payload.text).toContain(
      'a⟦outer comment (user): outer⟧b⟦inner comment (user): inner⟧cd⟦/inner⟧e⟦/outer⟧f',
    )
  })

  it('renders suggestions, replies, untagged external diffs, and a missing annotation fallback', () => {
    const annotation = {
      id: 'a1', seq: 2, kind: 'suggestion' as const, author: 'agent' as const, agent: null,
      status: 'open' as const, quote: 'missing', text: 'replacement', line: 99,
      replies: [{ id: 'r1', seq: 3, author: 'user' as const, text: 'Why?' }],
    }
    const state = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', document: 'present', annotations: [annotation],
    })
    expect(state.text).toContain('present')
    expect(state.text).toContain('Annotations not shown inline:')
    expect(state.text).toContain('- a1 suggestion (agent) [open, line 99]: replacement')
    expect(state.text).toContain('quote: missing')
    expect(state.text).toContain('↳ user: Why?')

    const changes = createPayload({
      file, buffer, agent: 'ag_1', event: 'changes',
      annotations: [annotation],
      segments: [{
        author: 'external',
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, removed: [], added: ['new'] }],
      }, {
        author: 'user',
        hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, removed: ['x'], added: ['y'] }],
      }],
    })
    expect(changes.text).toContain('Changes by external:')
    expect(changes.text).not.toContain('Changes by user:')
    expect(changes.segments).toHaveLength(1)
    expect(changes.text).toContain('~~missing~~ replacement⟦/a1⟧\n  ↳ user: Why?')
    expect(changes.text).toContain('@@ -0,0 +1 @@')
  })
})
