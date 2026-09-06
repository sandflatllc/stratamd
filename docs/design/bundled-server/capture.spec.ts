// Captures the proposed bundled-server dialogs inside the real app: the built
// main process, the fake T3 engine the e2e suite uses, the shipped Strata
// Vivid theme, and each proposed dialog injected with the renderer's own
// classes (dialogs.ts). Run from the repository root after a build:
//
//   xvfb-run -a ./node_modules/.bin/playwright test -c docs/design/bundled-server/playwright.config.ts
//
// Output: docs/design/bundled-server/captures/*.png at 1440 × 1000.
import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROVIDERS, seededScenario, startEngine } from '../../../test/e2e/cockpit-engine-harness'
import { openAppMenu } from '../../../test/e2e/harness'
import { PROTOTYPE_STYLE, background, general, providerClaude, thisComputer } from './dialogs'

const here = dirname(fileURLToPath(import.meta.url))
const captures = join(here, 'captures')
const usageAt = '2026-09-03T12:00:00.000Z'

/** The seeded accounts: Claude and Codex signed in with usage, the other three present but disabled, as on the owner's machine. */
const providers: unknown[] = [
  { ...(DEFAULT_PROVIDERS[1] as object), usage: { session: { usedPercent: 0, resetsAt: '2026-09-03T18:00:00.000Z', measuredAt: usageAt, source: 'probe' }, weekly: { usedPercent: 8, resetsAt: '2026-09-04T18:00:00.000Z', measuredAt: usageAt, source: 'probe' }, planLabel: 'Max', applicable: true } },
  { ...(DEFAULT_PROVIDERS[0] as object), displayName: 'Codex', usage: { session: { usedPercent: 31, resetsAt: '2026-09-03T16:00:00.000Z', measuredAt: usageAt, source: 'session' }, weekly: { usedPercent: 89, resetsAt: '2026-09-04T23:16:00.000Z', measuredAt: usageAt, source: 'session' }, planLabel: 'Pro 20x', applicable: true } },
  ...['cursor', 'grok', 'opencode'].map((driver) => ({ instanceId: driver, driver, displayName: driver === 'opencode' ? 'OpenCode' : driver[0]!.toUpperCase() + driver.slice(1), enabled: false, installed: false, status: 'disabled', auth: { status: 'unauthenticated' }, checkedAt: usageAt, models: [] })),
]

test('capture the proposed bundled-server dialogs', async ({}, testInfo) => {
  test.setTimeout(240_000)
  await mkdir(captures, { recursive: true })
  const engine = await startEngine({ providers })
  const scenario = await seededScenario(testInfo, engine.origin, '# Bundled server plan\n\nReview notes.\n', 'bundled-server-plan.md')
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000) })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Connected/)
    await page.addStyleTag({ content: PROTOTYPE_STYLE })

    const shoot = (name: string) => page.screenshot({ path: join(captures, `${name}.png`) })
    const inject = async (html: string) => {
      await page.evaluate((markup) => {
        document.querySelectorAll('[data-proto]').forEach((node) => node.remove())
        ;(document.querySelector('.app-shell') ?? document.body).insertAdjacentHTML('beforeend', markup)
      }, html)
      await page.getByRole('dialog').last().waitFor()
    }
    const clear = () => page.evaluate(() => { document.querySelectorAll('[data-proto]').forEach((node) => node.remove()) })

    // 1. Accounts today, with the footer's Engine action renamed This computer.
    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Accounts' }).click()
    const accounts = page.getByRole('dialog', { name: 'Accounts' })
    await expect(accounts.getByRole('region', { name: 'Codex' })).toBeVisible()
    await accounts.getByRole('button', { name: 'Engine', exact: true }).evaluate((node) => { node.textContent = 'This computer' })
    // The managed engine has no address to show and a stable launcher directory.
    await accounts.evaluate((dialog) => {
      const address = dialog.querySelector('.modal-subtitle code')
      if (address) address.replaceWith('this computer')
      const launchers = dialog.querySelector('.accounts-actions code')
      if (launchers) launchers.textContent = '~/.local/share/stratamd/bin'
    })
    await shoot('accounts')
    await page.keyboard.press('Escape')
    await expect(accounts).toBeHidden()

    // 2. The account's Manage view with the audit's added fields.
    await inject(providerClaude()); await shoot('provider-claude')
    // 3–5. General, its Advanced section, the background dialog.
    await inject(general(false)); await shoot('general')
    await inject(general(true))
    await page.getByRole('dialog', { name: 'Settings' }).locator('.setup-dialog-body').evaluate((body) => { body.scrollTop = body.scrollHeight })
    await shoot('general-advanced')
    await inject(background()); await shoot('background')
    // 6–7. This computer, signed out of T3 and connected.
    await inject(thisComputer('signed-out')); await shoot('this-computer')
    await inject(thisComputer('connected'))
    await page.getByRole('dialog', { name: 'This computer' }).locator('.setup-dialog-body').evaluate((body) => {
      const section = [...body.querySelectorAll('.proto-section h3')].find((node) => node.textContent === 'T3 Connect')
      body.scrollTop = section ? (section as HTMLElement).offsetTop - 24 : body.scrollHeight
    })
    await shoot('t3-connected')
    // 8. The engine stopped: the real shell shows Disconnected behind the dialog.
    await clear()
    engine.setOnline(false)
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Disconnected/, { timeout: 10_000 })
    await inject(thisComputer('stopped')); await shoot('recovery')
    await clear()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
