import { describe, expect, it } from 'vitest'
import { LayoutReadiness } from '../../src/editor/layout-readiness'

// Readiness is generation-scoped: late settles from earlier work cannot
// complete a newer generation, and destruction releases waiters as failures.
describe('layout readiness', () => {
  it('settles when every registered participant reaches a terminal state', async () => {
    const readiness = new LayoutReadiness()
    let settled = false
    const image = readiness.begin('image')
    const diagram = readiness.begin('mermaid')
    void readiness.whenSettled().then(() => { settled = true })
    expect(readiness.pending).toBe(2)
    image()
    await Promise.resolve()
    expect(settled).toBe(false)
    diagram()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(readiness.pending).toBe(0)
    await expect(readiness.whenSettled()).resolves.toBeUndefined()
  })

  it('ignores a settle repeated or arriving after a reset', async () => {
    const readiness = new LayoutReadiness()
    const first = readiness.begin('image')
    const waiter = readiness.whenSettled()
    readiness.reset()
    await expect(waiter).rejects.toThrow('reset')
    expect(readiness.generation).toBe(1)
    const second = readiness.begin('image')
    first()
    expect(readiness.pending).toBe(1)
    second()
    second()
    expect(readiness.pending).toBe(0)
  })

  it('rejects waiters on destroy and refuses new work afterwards', async () => {
    const readiness = new LayoutReadiness()
    readiness.begin('chart')
    const waiter = readiness.whenSettled()
    readiness.destroy()
    await expect(waiter).rejects.toThrow('destroyed')
    readiness.begin('image')()
    expect(readiness.pending).toBe(0)
    await expect(readiness.whenSettled()).rejects.toThrow('destroyed')
  })

  it('passes through a test gate only when one is installed', async () => {
    const held: string[] = []
    let release: (() => void) | null = null
    const gated = new LayoutReadiness((kind) => { held.push(kind); return new Promise<void>((resolve) => { release = resolve }) })
    let passed = false
    void gated.pass('image-decode').then(() => { passed = true })
    await Promise.resolve()
    expect(held).toEqual(['image-decode'])
    expect(passed).toBe(false)
    release!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(passed).toBe(true)
    await expect(new LayoutReadiness().pass('mermaid')).resolves.toBeUndefined()
  })

  it('reports labels and notifies listeners on every change', () => {
    const readiness = new LayoutReadiness()
    const seen: number[] = []
    const stop = readiness.onChange((snapshot) => seen.push(snapshot.pending))
    const done = readiness.begin('image:one.png')
    expect(readiness.snapshot().labels).toEqual(['image:one.png'])
    done()
    stop()
    readiness.begin('mermaid')
    expect(seen).toEqual([1, 0])
  })
})
