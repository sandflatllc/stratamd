import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { processStamp, takeEngineLock, verifiedProcess } from '../../src/main/engine/managed-process'

it('admits one owner and does not remove the live owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-lock-'))
  const release = await takeEngineLock(root)
  try {
    const original = await readFile(join(root, 'lock'), 'utf8')
    await expect(takeEngineLock(root)).rejects.toThrow('owns')
    expect(await readFile(join(root, 'lock'), 'utf8')).toBe(original)
    expect(await verifiedProcess({ pid: process.pid, ...await processStamp(process.pid), executable: process.execPath, baseDirectory: root })).toBe(false)
  } finally { await release(); await rm(root, { recursive: true, force: true }) }
})

it('serializes competing reclaimers of a dead incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-lock-'))
  await writeFile(join(root, 'lock'), JSON.stringify({ pid: process.pid, bootId: 'previous-boot', startTime: '0' }))
  const results = await Promise.allSettled([takeEngineLock(root), takeEngineLock(root)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  for (const result of results) if (result.status === 'fulfilled') await result.value()
  await rm(root, { recursive: true, force: true })
})
