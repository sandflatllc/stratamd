import { describe, expect, it, vi } from 'vitest'
import type { NativeImage, WebContents } from 'electron'
import { captureWhenPainted } from '../../src/main/preview/capture'

const frame = (empty = false) => ({ isEmpty: () => empty }) as NativeImage
function contents(capturePage: ReturnType<typeof vi.fn>, painted = () => {}) {
  return { capturePage, isDestroyed: () => false, executeJavaScript: vi.fn(async () => painted()) } as unknown as Pick<WebContents, 'capturePage' | 'executeJavaScript' | 'isDestroyed'>
}

describe('preview compositor readiness', () => {
  it('waits for frames after both Chromium missing-frame outcomes', async () => {
    const image = frame()
    const page = contents(vi.fn().mockRejectedValueOnce(new Error('UnknownVizError')).mockResolvedValueOnce(frame(true)).mockResolvedValue(image))
    expect(await captureWhenPainted(page, 'Preview tab test', () => 0)).toBe(image)
    expect(page.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('keeps the existing deadline and names the affected tab', async () => {
    let now = 0
    const page = contents(vi.fn().mockRejectedValue(new Error('UnknownVizError')), () => { now += 2500 })
    await expect(captureWhenPainted(page, 'Preview tab test', () => now)).rejects.toThrow('Preview tab test has not produced a capturable frame')
  })

  it('does not retry unrelated capture errors', async () => {
    const error = new Error('Capture permission denied')
    const page = contents(vi.fn().mockRejectedValue(error))
    await expect(captureWhenPainted(page, 'Preview tab test', () => 0)).rejects.toBe(error)
    expect(page.executeJavaScript).not.toHaveBeenCalled()
  })
})
