import { mainEntry } from './harness'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import type { Page, TestInfo } from '@playwright/test'

const now = Date.parse('2026-09-03T12:02:00.000Z')
const checkedAt = new Date(now).toISOString()
const week = { id: 'primary', label: 'Week', kind: 'weekly', usedPercent: 26, resetsAt: '2026-09-05T12:02:00.000Z', windowDurationMins: 10080 }
const providers = () => [
  { instanceId: 'codex', driver: 'codex', displayName: 'Codex work', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated', type: 'chatgpt', label: 'Pro', email: 'owner@example.com' }, usageLimits: { checkedAt, windows: [week], resetCredits: { availableCount: 1 } } },
  { instanceId: 'claude-main', driver: 'claudeAgent', displayName: 'Claude', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated', type: 'oauth', label: 'Max' }, usageLimits: { checkedAt, windows: [{ ...week, id: 'five_hour', label: '5 hours', kind: 'session', usedPercent: 32, resetsAt: '2026-09-03T14:12:00.000Z', windowDurationMins: 300 }, { ...week, id: 'seven_day', usedPercent: 19 }] } },
]
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' })
}
async function open(page: Page) {
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; caret-color: transparent !important; }' })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440)
  await page.getByRole('button', { name: 'StrataMD menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Usage Limits', exact: true })
  const grip = dialog.getByRole('button', { name: 'Resize Usage Limits', exact: true })
  const bounds = await dialog.boundingBox()
  const point = await grip.boundingBox()
  await page.mouse.move(point!.x + point!.width / 2, point!.y + point!.height / 2)
  await page.mouse.down()
  await page.mouse.move(point!.x + point!.width / 2 + (960 - bounds!.width) / 2, point!.y + point!.height / 2 + (760 - bounds!.height) / 2)
  await page.mouse.up()
  await expect.poll(() => dialog.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(960)
  return dialog
}

test('reported account windows, equal-contribution summary and guarded reset confirmation', async ({}, testInfo) => {
  let outcome = 'nothingToReset'
  const engine = await startEngine({ providers: providers(), consumeResetCredit: () => ({ outcome }) })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const clockFile = join(scenario.root, 'quota-clock.mjs')
    await writeFile(clockFile, `Date.now = () => ${now}; process.argv.splice(1, 1); await import(${JSON.stringify(pathToFileURL(mainEntry).href)});`)
    scenario.env.TZ = 'UTC'
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch(scenario.file, [clockFile])
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.clock.setFixedTime(now)
    const dialog = await open(page)
    await expect(dialog.getByRole('meter', { name: 'Week remaining', exact: true })).toHaveCount(2)
    await expect(dialog.getByRole('meter', { name: '5 hours remaining', exact: true })).toHaveCount(1)
    await expect(dialog.locator('[data-instance="codex"] .account-quota')).toHaveCount(1)
    await capture(page, testInfo, 'usage-accounts')
    await dialog.getByRole('button', { name: 'Combined', exact: true }).click()
    await expect(dialog.getByRole('meter', { name: 'Week · 2 accounts remaining' })).toHaveAttribute('aria-valuenow', '78')
    await expect(dialog.getByRole('meter', { name: '5 hours · 1 account remaining' })).toHaveAttribute('aria-valuenow', '68')
    await capture(page, testInfo, 'usage-pooled')
    await dialog.getByRole('button', { name: 'By account', exact: true }).click()
    await dialog.getByRole('button', { name: 'Use reset credit for Codex work…', exact: true }).click()
    expect(engine.rpcRequests.filter(request => request.tag === 'provider.consumeResetCredit')).toHaveLength(0)
    await capture(page, testInfo, 'usage-reset')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(engine.rpcRequests.filter(request => request.tag === 'provider.consumeResetCredit')).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Use reset credit for Codex work…', exact: true }).click()
    await dialog.getByRole('button', { name: 'Use reset credit', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('nothing to reset')
    expect(engine.rpcRequests.filter(request => request.tag === 'provider.consumeResetCredit')).toEqual([{ tag: 'provider.consumeResetCredit', payload: { instanceId: 'codex' } }])
    await expect(dialog.locator('[data-instance="codex"] [role="meter"]')).toHaveAttribute('aria-valuenow', '74')
    outcome = 'reset'
    await dialog.getByRole('button', { name: 'Use reset credit for Codex work…', exact: true }).click()
    await dialog.getByRole('button', { name: 'Use reset credit', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('The provider reset the account limits.')
    await expect(dialog.locator('[data-instance="codex"] [role="meter"]')).toHaveAttribute('aria-valuenow', '74')
    await capture(page, testInfo, 'usage-reset-success')
    await dialog.getByRole('button', { name: 'Park Codex work', exact: true }).click()
    await expect(dialog.locator('[data-instance="codex"]')).toHaveAttribute('data-parked', 'true')
  } finally { await scenario.dispose(); await engine.close() }
})

test('failed probes preserve old bars and unsupported clears usage and credits', async ({}, testInfo) => {
  const engine = await startEngine({ providers: providers(), consumeResetCredit: () => null })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const clockFile = join(scenario.root, 'quota-clock.mjs')
    await writeFile(clockFile, `Date.now = () => ${now}; process.argv.splice(1, 1); await import(${JSON.stringify(pathToFileURL(mainEntry).href)});`)
    scenario.env.TZ = 'UTC'
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch(scenario.file, [clockFile])
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.clock.setFixedTime(now)
    const dialog = await open(page)
    await dialog.getByRole('button', { name: 'Use reset credit for Codex work…', exact: true }).click()
    await dialog.getByRole('button', { name: 'Use reset credit', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('unreadable reset-credit result')
    await dialog.getByRole('alert').scrollIntoViewIfNeeded()
    await capture(page, testInfo, 'usage-reset-error')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    engine.setProviders(providers().map(provider => ({ ...provider, usageLimits: { checkedAt, windows: [], unavailable: { reason: 'probeFailed', message: 'The provider is offline.' } } })))
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(dialog.locator('.account-quota')).toHaveCount(3)
    await expect(dialog).toContainText('The bars show the last report')
    await expect(dialog.getByRole('button', { name: /Use reset credit for/ })).toHaveCount(0)
    await capture(page, testInfo, 'usage-stale')
    engine.setProviders(providers().map(provider => ({ ...provider, usageLimits: { checkedAt, windows: [], unavailable: { reason: 'unsupported' } } })))
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(dialog.getByRole('meter')).toHaveCount(0)
    await expect(dialog.getByText('This account does not support usage reports.', { exact: true })).toHaveCount(2)
    await capture(page, testInfo, 'usage-unavailable')
  } finally { await scenario.dispose(); await engine.close() }
})
