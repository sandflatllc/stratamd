import { expect, type Locator, type Page } from '@playwright/test'

/** Wait for visibility and two matching readings across animation frames. */
export async function settledBox(page: Page, locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible()
  let settled: Awaited<ReturnType<Locator['boundingBox']>> = null
  await expect.poll(async () => {
    const before = await locator.boundingBox()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const after = await locator.boundingBox()
    if (!before || !after) return false
    if (Math.abs(after.x - before.x) >= 0.5 || Math.abs(after.y - before.y) >= 0.5 || Math.abs(after.width - before.width) >= 0.5 || Math.abs(after.height - before.height) >= 0.5) return false
    settled = after
    return true
  }, { message: 'The visible target must stop moving before coordinate input' }).toBe(true)
  return settled!
}
