import { _electron as electron } from '@playwright/test'
import { expect, test } from './test'
import { Scenario } from './harness'

test('launch readiness includes the initial window load before state assertions', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Startup readiness\n')
  const originalLaunch = electron.launch
  let releaseFonts!: () => void
  const fontsReleased = new Promise<void>(resolve => { releaseFonts = resolve })
  let blocked = false, settled = false
  let launching: ReturnType<Scenario['launch']> | undefined
  electron.launch = async options => {
    const app = await originalLaunch.call(electron, options)
    await app.context().route(/\.woff2$/, async route => {
      blocked = true
      await fontsReleased
      await route.continue()
    })
    return app
  }
  try {
    launching = scenario.launch().then(page => { settled = true; return page })
    void launching.catch(() => undefined)
    await expect.poll(() => blocked && !!scenario.page).toBe(true)
    const page = scenario.page!
    await expect(page.getByRole('button', { name: 'Docs menu', exact: true })).toBeVisible()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON().loadEventEnd)).toBe(0)
    expect(settled).toBe(false)
    releaseFonts()
    await launching
    expect(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON().loadEventEnd)).toBeGreaterThan(0)
  } finally {
    releaseFonts()
    electron.launch = originalLaunch
    await launching?.catch(() => undefined)
    await scenario.dispose()
  }
})
