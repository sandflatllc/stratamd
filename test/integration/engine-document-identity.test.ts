import { expect, it } from 'vitest'
import { attach, fixture } from './support/cockpit'

it('archives queued document deliveries and Lead when another engine has the same thread id, and restores them on return', async () => {
  const value = await fixture()
  value.engine.changeIdentity('first')
  await value.app.openDocument(value.path)
  await attach(value, 't1', { acknowledge: false })
  await value.app.setLead(value.path, 't1')
  const before = value.engine.turns.length
  value.engine.changeIdentity('second')
  await expect.poll(async () => (await value.app.getState()).activeDocument?.attachments).toEqual([])
  expect((await value.app.getState()).activeDocument?.leadAgentId).toBeNull()
  expect(value.engine.turns).toHaveLength(before)
  await expect.poll(async () => (await value.store.loadMeta(value.path)).engineIdentity).toBe('second')
  const meta = await value.store.loadMeta(value.path)
  expect(meta.engineIdentity).toBe('second')
  expect(meta.engineAttachments?.first?.leadAgentId).toBe('t1')
  expect(Object.keys(meta.engineAttachments?.first?.attachments ?? {})).toEqual(['t1'])
  await value.restart()
  await value.app.openDocument(value.path)
  expect((await value.app.getState()).activeDocument?.attachments).toEqual([])
  value.engine.changeIdentity('first')
  await expect.poll(async () => (await value.app.getState()).activeDocument?.leadAgentId).toBe('t1')
  expect((await value.app.getState()).activeDocument?.attachments[0]?.queuedSendCount).toBe(1)
})
