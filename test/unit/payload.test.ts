import { describe, expect, it } from 'vitest'
import {
  createPayload,
  guardrailLine,
  MESSAGE_GUIDANCE_LINE,
  PAYLOAD_VERSION,
  writeOnlyLine,
  serializePayload,
  trimPayload,
  type PayloadEvent,
} from '../../src/core/payload'

const file = '/docs/plan.md'
const buffer = '/data/stratamd/buffer.md'

describe('payload v13', () => {
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

  it('serializes documented fields as version 13 and omits absent fields', () => {
    const payload = createPayload({ file, buffer, agent: 'ag_1', event: 'timeout' })
    const json = JSON.parse(serializePayload(payload)) as Record<string, unknown>
    expect(json.version).toBe(PAYLOAD_VERSION)
    expect(json).not.toHaveProperty('deliveryId')
    expect(json).not.toHaveProperty('document')
    expect(json).not.toHaveProperty('notes')
  })

  it('renders table discussion context in structured data and readable text', () => {
    const context = {
      kind: 'table-cell' as const,
      heading: 'Island review',
      columns: ['Name', 'Verdict'],
      column: { index: 1, label: 'Verdict' },
    }
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', deliveryId: 'd_table',
      annotations: [{
        id: 'a_table', seq: 1, kind: 'question', author: 'user', agent: null, status: 'open',
        quote: '| Alpha | Unprotected |', text: 'What protects this?', line: 3, replies: [], context,
      }],
    }, { currentDocument: '| Name | Verdict |\n| --- | --- |\n| Alpha | Unprotected |' })
    expect(payload.annotations?.[0]?.context).toEqual(context)
    expect(payload.text).toContain('[Table under Island review; columns Name, Verdict; column 2 Verdict]')
  })

  it('renders screenshot-pin discussion context in structured data and readable text', () => {
    const context = {
      kind: 'screenshot-pin' as const,
      component: 'AnnotatedScreenshot' as const,
      componentLine: 40,
      image: './review.png',
      pin: 3,
    }
    const quote = '| 3 | 75.0 | 20.0 | 68:123 | Agent pin |'
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', deliveryId: 'd_pin',
      annotations: [{
        id: 'a_pin', seq: 1, kind: 'question', author: 'user', agent: null, status: 'open',
        quote, text: 'Does this align?', line: 45, replies: [], context,
      }],
    }, { currentDocument: `<AnnotatedScreenshot>\n![Review](./review.png)\n\n${quote}\n</AnnotatedScreenshot>` })
    expect(payload.annotations?.[0]?.context).toEqual(context)
    expect(payload.text).toContain('[AnnotatedScreenshot line 40; pin 3; image ./review.png]')
  })

  it('renders open decisions and incremental structured owner answers', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', cursor: 3,
      annotations: [{
        id: 'd1', seq: 1, kind: 'decision', author: 'agent', agent: 'ag_2', status: 'open',
        anchor: 'document', quote: '', text: 'Which gate?', line: 1, replies: [],
        decision: { options: ['CI', 'Manual'], answers: [] },
      }],
      answers: [{
        annotation: 'd0', seq: 3, option: null, other: 'Stage it', author: 'user', answeredAt: 100,
        parent: { text: 'How should this ship?', options: ['Now', 'Later'], anchor: 'heading', quote: '## Delivery', line: 8 },
      }],
    })
    expect(payload.text).toContain('d1 decision (ag_2) [Choices: CI | Manual | Other]')
    expect(payload.text).toContain('Decision answers:\nd0 ← user answered Other: Stage it')
    expect(payload.text).toContain('decision: How should this ship? (line 8); choices: Now | Later | Other')

    const state = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', document: 'Body\n', cursor: 3,
      annotations: payload.annotations!,
    })
    expect(state.text).toContain('Open decisions:\n- d1 (whole document): Which gate?\n  choices: CI | Manual | Other')
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
    expect(MESSAGE_GUIDANCE_LINE).toContain('stratamd state --brief')
    expect(MESSAGE_GUIDANCE_LINE).toContain('stratamd state')
    expect(MESSAGE_GUIDANCE_LINE).toContain('stratamd changes')

    const json = JSON.parse(serializePayload(payload)) as Record<string, unknown>
    expect(json).toMatchObject({
      version: 13,
      event: 'message',
      deliveryId: 'm_1',
      from: { agent: 'ag_2', name: 'GPT' },
      notes: ['Ready for your pass.'],
    })
    expect(json).not.toHaveProperty('document')
    expect(json).not.toHaveProperty('segments')
  })

  it('trims a payload to the brief or text-only view without touching the original', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', open: true, cursor: 3,
      document: 'Body.\n', annotations: [],
      attachments: [{ agent: 'ag_2', name: 'GPT', state: 'waiting', lead: true }],
    })
    expect(trimPayload(payload, {})).toBe(payload)

    const textOnly = trimPayload(payload, { textOnly: true })
    expect(textOnly).not.toHaveProperty('document')
    expect(textOnly).toMatchObject({ text: payload.text, annotations: [], open: true, cursor: 3 })

    const brief = trimPayload(payload, { brief: true })
    expect(brief).not.toHaveProperty('document')
    expect(brief).not.toHaveProperty('text')
    expect(brief).not.toHaveProperty('annotations')
    expect(brief).toMatchObject({
      version: PAYLOAD_VERSION, event: 'state', file, buffer, open: true, cursor: 3,
      attachments: [{ agent: 'ag_2', name: 'GPT', state: 'waiting', lead: true }],
    })
    expect(payload.document).toBe('Body.\n')
    expect(JSON.parse(serializePayload(payload))).toMatchObject({ open: true })
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

describe('payload markers and delivery context', () => {
  it('escapes annotation text in markers, collapses heading newlines, and names the agent', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', document: 'alpha beta',
      annotations: [{
        id: 'a1', seq: 1, kind: 'comment', author: 'agent', agent: 'ag_2', name: 'GPT', label: 'Tone',
        status: 'open', quote: 'beta', text: 'first ⟦line⟧\nsecond line', line: 1, replies: [],
      }],
    })
    expect(payload.text).toContain('alpha ⟦a1 comment (GPT ag_2) [Tone]: first \\⟦line\\⟧ second line⟧beta⟦/a1⟧')
  })

  it('renders a suggestion replacement once, escaped, after the struck quote', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', document: 'keep old text here',
      annotations: [{
        id: 's1', seq: 1, kind: 'suggestion', author: 'agent', agent: 'ag_2',
        status: 'open', quote: 'old text', text: 'new ⟦text⟧', line: 1, replies: [],
      }],
    })
    expect(payload.text).toContain('keep ⟦s1 suggestion (ag_2)⟧~~old text~~ new \\⟦text\\⟧⟦/s1⟧ here')
    expect(payload.text.match(/new \\⟦text\\⟧/g)).toHaveLength(1)
  })

  it('renders a lone reply with the thread it continues', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', deliveryId: 'd_3', cursor: 9,
      replies: [{
        id: 'r2', seq: 8, annotation: 'a1', author: 'agent', agent: 'ag_2', name: 'GPT', text: 'Agreed.',
        parent: { kind: 'question', quote: 'the long\nspan', line: 4, text: 'Why?' },
      }],
    })
    expect(payload.text).toContain('Replies:\na1 ← GPT ag_2: Agreed.\n  thread: question on line 4 about "the long span": Why?')
  })

  it('renders hunk context lines and widens the header to cover them', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'send', deliveryId: 'd_4',
      segments: [{
        author: 'user',
        hunks: [
          { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, removed: ['old'], added: ['new'], contextBefore: ['first'], contextAfter: ['third'], line: 2 },
          { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, removed: [], added: ['top'], contextBefore: [], contextAfter: ['first'], line: 1 },
        ],
      }],
    })
    expect(payload.text).toContain('@@ -1,3 +1,3 @@\n first\n-old\n+new\n third')
    expect(payload.text).toContain('@@ -1 +1,2 @@\n+top\n first')
  })

  it('trims to the annotations view: no document, text is the open questions', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', open: true, cursor: 2, document: 'Why now?\n',
      annotations: [
        { id: 'a1', seq: 1, kind: 'question', author: 'user', agent: null, status: 'open', quote: 'Why now?', text: 'Justify\nthis', line: 1, replies: [] },
        { id: 'a2', seq: 2, kind: 'comment', author: 'user', agent: null, status: 'open', quote: 'now', text: 'note', line: 1, replies: [] },
      ],
    })
    const view = trimPayload(payload, { annotationsOnly: true })
    expect(view).not.toHaveProperty('document')
    expect(view.annotations).toHaveLength(2)
    expect(view.text).toBe('Open questions:\n- a1 on line 1: Justify this')
    expect(payload.document).toBe('Why now?\n')
  })

  it('includes open decisions in the annotations-only text view', () => {
    const payload = createPayload({
      file, buffer, agent: 'ag_1', event: 'state', document: 'Body',
      annotations: [{ id: 'd1', seq: 1, kind: 'decision', author: 'user', agent: null, status: 'open', anchor: 'document', quote: '', text: 'Choose?', line: 1, replies: [], decision: { options: ['A', 'B'], answers: [] } }],
    })
    expect(trimPayload(payload, { annotationsOnly: true }).text).toBe('Open decisions:\n- d1 (whole document): Choose?\n  choices: A | B | Other')
  })
})
