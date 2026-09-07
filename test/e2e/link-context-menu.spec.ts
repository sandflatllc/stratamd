import { expect, test } from '@playwright/test'
import { dirname, join } from 'node:path'
import { Scenario } from './harness'
import { openThread } from './cockpit-agent'
import { seededScenario, startEngine } from './cockpit-engine-harness'

// Right-click on a link copies its target (PRD §6.9): the address of a web
// link, the full path of a file link, and the link as the author wrote it.
const document = '# Links\n\nSee [the site](https://example.com/page?tab=1) and [the prototype](design/prototype.html?state=working).\n'

test('right-click on a link copies its address or full path instead of opening the annotate menu', { tag: '@clipboard' }, async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, document, 'links.md')
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    const menu = page.getByRole('menu', { name: 'Link actions' })

    await page.getByRole('link', { name: 'the site', exact: true }).click({ button: 'right' })
    await expect(menu).toBeVisible()
    await expect(page.getByRole('menu', { name: 'Annotate selection' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Copy link address' })).toBeFocused()
    await menu.getByRole('menuitem', { name: 'Copy link address' }).click()
    await expect(menu).toHaveCount(0)
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://example.com/page?tab=1')

    const prototype = page.getByRole('link', { name: 'the prototype', exact: true })
    await prototype.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Copy full path' }).click()
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(dirname(scenario.file), 'design', 'prototype.html'))

    await prototype.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Copy link as written' }).click()
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('design/prototype.html?state=working')

    // Escape closes the menu and returns focus to the link.
    await prototype.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(prototype).toBeFocused()
  } finally {
    await scenario.dispose()
  }
})

test('a transcript link resolves its full path against the project folder', { tag: '@clipboard' }, async ({}, testInfo) => {
  const engine = await startEngine({ workspaceRoot: '/tmp/cockpit-links' })
  engine.postAssistant('t1', 'Open [prototype.html](docs/prototype.html?state=working) to check.')
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    await openThread(page, 'Live engine thread')
    const link = page.locator('.conversation-panel:visible').getByRole('link', { name: 'prototype.html', exact: true })
    await link.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Link actions' })
    await expect(menu).toBeVisible()
    await expect(page.getByRole('menu', { name: 'Annotate selection' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Copy full path' }).click()
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('/tmp/cockpit-links/docs/prototype.html')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
