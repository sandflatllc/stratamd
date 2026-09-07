import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { selectNavigationTab } from './harness'

/** PRD §6.9: the owner sets folder order by dragging a header; the order survives reload; Alt+Arrow moves a focused header. */
test('project folders reorder by drag and keyboard, keep their open state, and remember the order across reload', async ({}, testInfo) => {
  const engine = await startEngine({ projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await selectNavigationTab(page, 'Projects')
    const projects = page.locator('.projects-panel')
    const headers = projects.locator('.project-folder-header')
    const titles = projects.locator('.project-folder-header strong')
    const groups = projects.locator('.project-group')
    await expect(titles).toHaveText(['Cockpit project', 'Second project'])
    await expect(groups.nth(1)).toHaveAttribute('data-open', 'true')

    const second = (await headers.nth(1).boundingBox())!
    const first = (await headers.nth(0).boundingBox())!
    await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2)
    await page.mouse.down()
    await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2 + 6, { steps: 2 })
    await page.mouse.move(first.x + first.width / 2, first.y + 3, { steps: 6 })
    await expect(groups.nth(0)).toHaveAttribute('data-drop', 'before')
    await expect(groups.nth(1)).toHaveAttribute('data-dragging', 'true')
    await page.mouse.up()
    await expect(titles).toHaveText(['Second project', 'Cockpit project'])
    await expect(groups.nth(0)).toHaveAttribute('data-open', 'true')
    await expect(projects.locator('[data-drop], [data-dragging]')).toHaveCount(0)

    await page.reload()
    await selectNavigationTab(page, 'Projects')
    await expect(titles).toHaveText(['Second project', 'Cockpit project'])

    await headers.nth(0).focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect(titles).toHaveText(['Cockpit project', 'Second project'])
    await expect(groups.nth(1)).toHaveAttribute('data-open', 'true')

    await headers.nth(0).click()
    await expect(groups.nth(0)).toHaveAttribute('data-open', 'false')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
