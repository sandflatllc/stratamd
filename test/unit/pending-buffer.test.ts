import { afterEach, expect, it, vi } from 'vitest'
import { acknowledgeBufferEcho, flushPendingBuffer, forgetFlushed, setPendingBuffer, takePendingBuffer } from '../../src/renderer/pendingBuffer'

afterEach(() => { forgetFlushed(new Set()); takePendingBuffer(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('recognizes a delayed older flush after newer typing is sent, then allows external restoration of older text', async () => {
  vi.stubGlobal('window', { strata: { updateBuffer: vi.fn(async () => {}) } })
  const path = '/document.md'
  setPendingBuffer({ path, content: 'First paste', origin: 'edit' })
  await flushPendingBuffer()
  setPendingBuffer({ path, content: 'First paste plus second paste', origin: 'edit' })
  await flushPendingBuffer()
  // Main's first publication reaches the editor after the second flush starts.
  expect(acknowledgeBufferEcho(path, 'First paste')).toBe(true)
  expect(acknowledgeBufferEcho(path, 'First paste')).toBe(true)
  expect(acknowledgeBufferEcho(path, 'First paste plus second paste')).toBe(true)
  expect(acknowledgeBufferEcho(path, 'First paste')).toBe(false)
  expect(acknowledgeBufferEcho(path, 'External edit')).toBe(false)
})

it('releases coalesced older echoes and closed documents', async () => {
  vi.stubGlobal('window', { strata: { updateBuffer: vi.fn(async () => {}) } })
  for (const content of ['One', 'Two', 'Three']) {
    setPendingBuffer({ path: '/document.md', content, origin: 'edit' })
    await flushPendingBuffer()
  }
  expect(acknowledgeBufferEcho('/document.md', 'Three')).toBe(true)
  expect(acknowledgeBufferEcho('/document.md', 'Two')).toBe(false)
  forgetFlushed(new Set())
  expect(acknowledgeBufferEcho('/document.md', 'Three')).toBe(false)
})

it('prepares only the newest pending text and retains its ranges with a failed flush', async () => {
  const push = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined)
  vi.stubGlobal('window', { strata: { updateBuffer: push } })
  const discarded = vi.fn(() => [{ from: 0, to: 3 }])
  const retained = vi.fn(() => [{ from: 0, to: 7 }])
  setPendingBuffer({ path: '/document.md', content: 'Old', origin: 'edit', prepareBlockRanges: discarded })
  setPendingBuffer({ path: '/document.md', content: 'New one', origin: 'edit', prepareBlockRanges: retained })
  expect(retained).not.toHaveBeenCalled()
  await expect(flushPendingBuffer()).rejects.toThrow('unavailable')
  await flushPendingBuffer()
  expect(discarded).not.toHaveBeenCalled()
  expect(push.mock.calls).toEqual([
    ['/document.md', 'New one', 'edit', [{ from: 0, to: 7 }]],
    ['/document.md', 'New one', 'edit', [{ from: 0, to: 7 }]],
  ])
})


it('flushes recoverable text even if optional range preparation throws', async () => {
  const push = vi.fn(async () => {})
  vi.stubGlobal('window', { strata: { updateBuffer: push } })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  setPendingBuffer({ path: '/document.md', content: 'Recover this text', origin: 'edit', prepareBlockRanges: () => { throw new Error('parser failed') } })
  await flushPendingBuffer()
  expect(push).toHaveBeenCalledWith('/document.md', 'Recover this text', 'edit', undefined)
  expect(takePendingBuffer()).toBeNull()
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('/document.md'), expect.any(Error))
})
