import { describe, expect, it, vi } from 'vitest'
import {
  AttachmentCallRegistry,
  SessionRegistry,
  attachmentShouldExpire,
  attachmentState,
  documentPathsFromArgv
} from '../../src/main/session'

describe('SessionRegistry', () => {
  it('keeps one tab per realpath and focuses an existing tab', async () => {
    let now = 10
    const changes = vi.fn()
    const registry = new SessionRegistry({
      canonicalize: async () => '/real/plan.md',
      now: () => now++,
      onChange: changes
    })

    expect((await registry.open('/link/plan.md')).kind).toBe('opened')
    expect((await registry.open('/real/plan.md')).kind).toBe('focused')
    expect(registry.size).toBe(1)
    expect(registry.focusedPath).toBe('/real/plan.md')
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('focuses the most recently used remaining tab on close', async () => {
    let now = 0
    const registry = new SessionRegistry({ canonicalize: async (path) => path, now: () => ++now })
    await registry.open('/a.md')
    await registry.open('/b.md')
    registry.focus('/a.md')
    registry.close('/a.md')
    expect(registry.focusedPath).toBe('/b.md')
  })

  it('moves the session identity once on an open-file rename', async () => {
    const registry = new SessionRegistry({ canonicalize: async (path) => `/real${path}` })
    await registry.open('/old.md')
    const moved = await registry.rename('/real/old.md', '/new.md')
    expect(moved?.path).toBe('/real/new.md')
    expect(registry.get('/real/old.md')).toBeUndefined()
    expect(registry.size).toBe(1)
    expect(registry.focusedPath).toBe('/real/new.md')
  })
})

describe('launch path parsing', () => {
  it('takes markdown paths and file URLs but ignores switches and other files', () => {
    expect(documentPathsFromArgv([
      '--inspect',
      '/tmp/a.md',
      'file:///tmp/a.md',
      'file:///tmp/space%20name.markdown',
      '/tmp/no.txt'
    ])).toEqual(['/tmp/a.md', '/tmp/space name.markdown'])
  })
})

describe('attachment orchestration', () => {
  it('supersedes the earlier concurrent call for the same agent', () => {
    const registry = new AttachmentCallRegistry()
    const firstSuperseded = vi.fn()
    const secondSuperseded = vi.fn()
    const first = registry.begin('agent-1', firstSuperseded)
    const second = registry.begin('agent-1', secondSuperseded)

    expect(firstSuperseded).toHaveBeenCalledOnce()
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
    first.finish()
    expect(second.isCurrent()).toBe(true)
    second.finish()
    expect(second.isCurrent()).toBe(false)
  })

  it('never expires a waiting attachment or one with an unacknowledged delivery', () => {
    const day = 24 * 60 * 60 * 1_000
    expect(attachmentShouldExpire({ lastCallAt: 0, queuedDeliveries: [], waiting: false }, day)).toBe(true)
    expect(attachmentShouldExpire({ lastCallAt: 0, queuedDeliveries: ['d1'], waiting: false }, day * 2)).toBe(false)
    expect(attachmentShouldExpire({ lastCallAt: 0, queuedDeliveries: [], waiting: true }, day * 2)).toBe(false)
    expect(attachmentState({ waiting: true, queuedDeliveries: ['d1'] })).toBe('waiting')
    expect(attachmentState({ waiting: false, queuedDeliveries: ['d1'] })).toBe('pending')
    expect(attachmentState({ waiting: false, queuedDeliveries: [] })).toBe('working')
  })
})
