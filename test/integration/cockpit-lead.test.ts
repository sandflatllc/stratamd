import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { attach, fixture, post, storedApplication, type Fixture } from './support/cockpit'

/**
 * The Lead (PRD §6.5, plan §5.6, §5.9): one attached thread may hold it; the
 * owner transfers and revokes it; accept, reject, save, and resolving others'
 * items are Lead-only verbs in the agent's strata block.
 */
describe('the Lead thread', () => {
  async function leadFixture(content = 'Use the old wording here.\n'): Promise<Fixture> {
    const value = await fixture(content, { threads: [{ id: 't_lead', title: 'Lead Agent' }, { id: 't_peer', title: 'Peer' }, { id: 't_third', title: 'Third' }] })
    await value.app.openDocument(value.path)
    await attach(value, 't_lead')
    await attach(value, 't_peer')
    return value
  }
  const claim = (path: string) => ({ verb: 'lead', document: path, action: 'claim' })

  it('grants a claim, denies the second naming the holder, and lets the owner transfer and revoke', async () => {
    const value = await leadFixture()
    expect(await post(value, 't_lead', [claim(value.path)])).toEqual(['1. applied'])
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBe('t_lead')
    // Re-claiming what you already hold is not a denial.
    expect(await post(value, 't_lead', [claim(value.path)])).toEqual(['1. applied'])
    expect(await post(value, 't_peer', [claim(value.path)])).toEqual(['1. failed: LEAD_TAKEN: Lead Agent (t_lead) already holds the Lead'])
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBe('t_lead')

    await value.app.setLead(value.path, 't_peer')
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBe('t_peer')
    await value.app.setLead(value.path, null)
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBeNull()
    expect(await post(value, 't_peer', [claim(value.path)])).toEqual(['1. applied'])
    // Release gives it up; a release by a thread that does not hold it changes nothing.
    expect(await post(value, 't_lead', [{ verb: 'lead', document: value.path, action: 'release' }])).toEqual(['1. applied'])
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBe('t_peer')
    expect(await post(value, 't_peer', [{ verb: 'lead', document: value.path, action: 'release' }])).toEqual(['1. applied'])
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBeNull()
  })

  it('dies with its attachment on detach, and survives a restart while the holder stays attached', async () => {
    const value = await leadFixture()
    await post(value, 't_lead', [claim(value.path)])
    await value.app.detachThread(value.path, 't_lead')
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBeNull()
    expect(await post(value, 't_peer', [claim(value.path)])).toEqual(['1. applied'])
    expect((await value.store.loadMeta(value.path)).leadAgentId).toBe('t_peer')

    await value.restart()
    await value.app.openDocument(value.path)
    expect((await value.app.getState()).activeDocument?.attachments.map((item) => item.agent.id)).toEqual(['t_peer'])
    expect((await value.app.getState()).activeDocument?.leadAgentId).toBe('t_peer')
  })

  it('gates accept, reject, resolve on others\' items, and save behind the Lead, naming the holder or saying nobody holds it', async () => {
    const value = await leadFixture()
    const [posted] = await post(value, 't_lead', [{ verb: 'suggest', anchor: { document: value.path, quote: 'old wording' }, replacement: 'new wording' }])
    const suggestionId = /applied as (a_[\w-]+)/u.exec(posted!)![1]!
    const commentId = await value.app.addAnnotation(value.path, { kind: 'comment', quote: 'here', text: 'User note.', from: 20, to: 24 })

    expect(await post(value, 't_peer', [
      { verb: 'accept', anchor: { item: suggestionId } },
      { verb: 'reject', anchor: { item: suggestionId } },
      { verb: 'resolve', anchor: { item: commentId } },
      { verb: 'save', document: value.path },
    ])).toEqual([
      '1. failed: NOT_LEAD: no agent holds the Lead',
      '2. failed: NOT_LEAD: no agent holds the Lead',
      '3. failed: NOT_LEAD: no agent holds the Lead',
      '4. failed: NOT_LEAD: no agent holds the Lead',
    ])
    await post(value, 't_lead', [claim(value.path)])
    expect(await post(value, 't_peer', [{ verb: 'save', document: value.path }, { verb: 'accept', anchor: { item: suggestionId } }])).toEqual([
      '1. failed: NOT_LEAD: Lead Agent (t_lead) holds the Lead',
      '2. failed: NOT_LEAD: Lead Agent (t_lead) holds the Lead',
    ])
    // Any thread may resolve items it authored, without the Lead.
    await value.app.setLead(value.path, null)
    expect(await post(value, 't_lead', [{ verb: 'resolve', anchor: { item: suggestionId } }])).toEqual([`1. applied as ${suggestionId}`])
    expect((await storedApplication(value.store, value.path)).annotations.annotations[suggestionId]).toMatchObject({ status: 'resolved' })
    expect((await value.app.getState()).activeDocument?.content).toBe('Use the old wording here.\n')
  })

  it('keeps decision answers owner-only and sends their structured history without a document change', async () => {
    const value = await leadFixture('# Lead\n\nChoose here.\n')
    const [posted] = await post(value, 't_peer', [{ verb: 'decision', anchor: { document: value.path, quote: 'Choose here' }, text: 'Which gate?', options: ['CI', 'Manual'] }])
    const id = /applied as (a_[\w-]+)/u.exec(posted!)![1]!
    await post(value, 't_lead', [claim(value.path)])
    expect(await post(value, 't_peer', [{ verb: 'resolve', anchor: { item: id } }])).toEqual(['1. failed: DECISION_OWNER_REQUIRED: decision answers are owner-only'])
    expect(await post(value, 't_lead', [{ verb: 'resolve', anchor: { item: id } }])).toEqual(['1. failed: DECISION_OWNER_REQUIRED: decision answers are owner-only'])

    const before = (await value.app.getState()).activeDocument!.content
    await value.app.answerDecision(value.path, id, { option: 'CI' })
    const answered = (await value.app.getState()).activeDocument!.annotations.find((annotation) => annotation.id === id)!
    expect(answered).toMatchObject({ kind: 'decision', status: 'resolved', decision: { options: ['CI', 'Manual'], answers: [{ option: 'CI', author: 'user' }] } })
    expect((await value.app.getState()).activeDocument!.content).toBe(before)
    expect((await value.app.getState()).activeDocument!.pendingHunks).toEqual([])
    const [preview] = await value.app.previewSend(value.path, { recipients: ['t_peer'], note: '', includeExternal: false })
    expect(preview?.items.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'answer', annotationKind: 'decision', text: 'CI' })]))
    expect(preview?.text).toContain('Decision answers:')
    await value.app.send(value.path, { recipients: ['t_peer'], note: '', includeExternal: false })
    expect((await storedApplication(value.store, value.path)).attachments.t_peer?.deliveries.at(-1)?.payload.answers).toEqual([expect.objectContaining({ annotation: id, option: 'CI' })])

    await value.app.reopenDecision(value.path, id)
    await value.app.answerDecision(value.path, id, { option: null, other: 'Stage it' })
    expect((await storedApplication(value.store, value.path)).annotations.annotations[id]?.decision?.answers).toHaveLength(2)
  })

  it('accepts and saves as the Lead: external authorship, a surviving pending hunk, and routed events', async () => {
    const original = 'Use the old wording here.\n'
    const value = await leadFixture(original)
    await attach(value, 't_third')
    const [posted] = await post(value, 't_peer', [{ verb: 'suggest', anchor: { document: value.path, quote: 'old wording' }, replacement: 'new wording' }])
    const suggestionId = /applied as (a_[\w-]+)/u.exec(posted!)![1]!
    await post(value, 't_lead', [claim(value.path)])
    expect(await post(value, 't_lead', [{ verb: 'accept', anchor: { item: suggestionId } }])).toEqual([`1. applied as ${suggestionId}`])

    let document = (await value.app.getState()).activeDocument!
    expect(document.content).toBe('Use the new wording here.\n')
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({ author: expect.objectContaining({ id: 't_lead', name: 'Lead Agent' }), saved: false })
    expect(await readFile(value.path, 'utf8')).toBe(original)

    expect(await post(value, 't_lead', [{ verb: 'save', document: value.path }])).toEqual(['1. applied'])
    expect(await readFile(value.path, 'utf8')).toBe('Use the new wording here.\n')
    document = (await value.app.getState()).activeDocument!
    expect(document.pendingHunks).toHaveLength(1)
    expect(document.pendingHunks[0]).toMatchObject({ author: expect.objectContaining({ id: 't_lead' }), saved: true })

    // Other threads see the change only as an external segment, only when included.
    const included = await value.app.previewSend(value.path, { recipients: ['t_third'], note: '', includeExternal: true })
    expect(included[0]?.text).toContain('Changes by Lead Agent (t_lead):')
    expect(included[0]?.text).toContain('+Use the new wording here.')

    // The suggestion's author receives `accepted`; the Lead's own delivery does not carry it.
    await value.app.send(value.path, { recipients: ['t_lead', 't_peer', 't_third'], note: '', includeExternal: false })
    const queued = (await storedApplication(value.store, value.path)).attachments
    expect(queued.t_peer?.deliveries.at(-1)?.payload.resolved).toEqual([expect.objectContaining({ id: suggestionId, resolution: 'accepted' })])
    expect(queued.t_lead?.deliveries.at(-1)?.payload.resolved ?? []).toEqual([])
    expect(queued.t_third?.deliveries.at(-1)?.payload.segments ?? []).toEqual([])

    // Revert removes the text while the annotation log keeps the accept: two records, two actors.
    const hunkId = document.pendingHunks[0]!.id
    await value.app.revertHunk(value.path, hunkId)
    document = (await value.app.getState()).activeDocument!
    expect(document.content).toBe(original)
    expect(document.dirty).toBe(true)
    const log = (await storedApplication(value.store, value.path)).annotations
    expect(log.annotations[suggestionId]).toMatchObject({ status: 'resolved', resolution: 'accepted' })
    expect(log.events.find((item) => item.type === 'accepted')).toMatchObject({ author: 'agent', agent: 't_lead' })
  })

  it('rejects as the Lead with the Lead recorded as the event actor', async () => {
    const value = await leadFixture()
    const [posted] = await post(value, 't_peer', [{ verb: 'suggest', anchor: { document: value.path, quote: 'old wording' }, replacement: 'new wording' }])
    const suggestionId = /applied as (a_[\w-]+)/u.exec(posted!)![1]!
    await post(value, 't_lead', [claim(value.path)])
    expect(await post(value, 't_lead', [{ verb: 'reject', anchor: { item: suggestionId } }])).toEqual([`1. applied as ${suggestionId}`])

    const log = (await storedApplication(value.store, value.path)).annotations
    expect(log.annotations[suggestionId]).toMatchObject({ status: 'resolved', resolution: 'rejected' })
    expect(log.events.find((item) => item.type === 'rejected')).toMatchObject({ author: 'agent', agent: 't_lead' })
    expect((await value.app.getState()).activeDocument?.content).toBe('Use the old wording here.\n')
  })

  it('fails a Lead save against a disk conflict with SAVE_BLOCKED and changes nothing', async () => {
    const value = await leadFixture('# Save\n\nOriginal.\n')
    await post(value, 't_lead', [claim(value.path)])
    await value.app.updateBuffer(value.path, '# Save\n\nMine.\n')
    await writeFile(value.path, '# Save\n\nRaced.\n')

    const [outcome] = await post(value, 't_lead', [{ verb: 'save', document: value.path }])
    expect(outcome).toMatch(/^1\. failed: SAVE_BLOCKED: /u)
    expect(await readFile(value.path, 'utf8')).toBe('# Save\n\nRaced.\n')
    expect((await value.app.getState()).activeDocument?.content).toBe('# Save\n\nMine.\n')
  })

  it('a reply from a thread lands on the item with the thread as its author, and a reply to an unknown item fails', async () => {
    const value = await leadFixture('# Reply\n\nTalk about this.\n')
    const commentId = await value.app.addAnnotation(value.path, { kind: 'comment', quote: 'Talk about this', text: 'Thoughts?', from: 10, to: 25 })
    const outcomes = await post(value, 't_peer', [{ verb: 'reply', anchor: { item: commentId }, text: 'Agreed.' }, { verb: 'reply', anchor: { item: 'a_missing' }, text: 'Lost.' }])
    expect(outcomes[0]).toBe(`1. applied as ${commentId}`)
    expect(outcomes[1]).toBe('2. failed: item a_missing was not found')
    const annotation = (await value.app.getState()).activeDocument!.annotations.find((candidate) => candidate.id === commentId)!
    expect(annotation.replies).toEqual([expect.objectContaining({ author: expect.objectContaining({ id: 't_peer', name: 'Peer' }), text: 'Agreed.' })])
  })
})
