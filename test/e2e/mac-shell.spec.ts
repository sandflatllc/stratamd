import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario } from './harness'

let scenario: Scenario

test.afterEach(async () => {
  await scenario?.dispose()
})

test('an open-file event opens the document through the command path', async ({}, testInfo) => {
  // Finder delivers opens as app `open-file` events on macOS. The queue and
  // handler are wired on every platform, so this contract is testable by
  // emitting the event synthetically (mac-plan §4.5).
  scenario = await Scenario.create(testInfo, '# First\n\nBody.\n')
  const page = await scenario.launch()

  const other = join(scenario.root, 'documents', 'finder-open.md')
  await writeFile(other, '# Finder Open\n\nDelivered by open-file.\n')
  await scenario.app!.evaluate(({ app }, path) => {
    app.emit('open-file', { preventDefault: () => undefined }, path)
  }, other)

  await expect(page.getByText('finder-open.md', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('Delivered by open-file', { exact: false }).first()).toBeVisible()
})

test('the application menu is minimal on macOS and absent on Linux', async ({}, testInfo) => {
  scenario = await Scenario.create(testInfo, '# Menu\n\nBody.\n')
  await scenario.launch()

  const menu = await scenario.app!.evaluate(({ Menu }) => {
    const applicationMenu = Menu.getApplicationMenu()
    if (!applicationMenu) return null
    return applicationMenu.items.map((item) => ({
      label: item.label,
      roles: item.submenu?.items.map((child) => child.role ?? child.type) ?? [],
    }))
  })

  if (process.platform === 'darwin') {
    expect(menu).not.toBeNull()
    const labels = menu!.map((item) => item.label)
    expect(labels).toContain('Edit')
    expect(labels).toContain('Window')
    // Pane zoom owns zooming (PRD §6.9): no window-zoom, reload, or devtools roles.
    const roles = menu!.flatMap((item) => item.roles)
    expect(roles).not.toContain('zoom')
    expect(roles).not.toContain('forcereload')
    expect(roles).not.toContain('toggledevtools')
  } else {
    expect(menu).toBeNull()
  }
})
