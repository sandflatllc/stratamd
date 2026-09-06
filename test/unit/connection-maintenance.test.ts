import { expect, it } from 'vitest'
import { ConnectionOperations } from '../../src/main/engine/connection-operations'
it('drains earlier mutations, suspends later writes for backup, and permits the owned reconnect before resuming', async () => {
  const operations = new ConnectionOperations()
  let finish!: () => void
  const earlier = operations.run(() => new Promise<void>(resolve => { finish = resolve }))
  let reserved = false
  const pause = operations.switch(async () => { operations.suspend(); reserved = true })
  await expect(operations.run(async () => undefined)).rejects.toThrow('changing')
  expect(reserved).toBe(false)
  finish(); await earlier; await pause
  await expect(operations.run(async () => undefined)).rejects.toThrow('changing')
  let reconnected = false
  await operations.switch(async () => { reconnected = true })
  expect(reconnected).toBe(true); expect(operations.accepting).toBe(false)
  operations.resume()
  expect(await operations.run(async () => 'safe')).toBe('safe')
})
