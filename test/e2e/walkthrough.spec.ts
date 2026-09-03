import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { Scenario, setSource } from './harness'

const filler = Array.from({ length: 18 }, (_, index) => `Reading paragraph ${index + 1} keeps the walkthrough target away from the scroll boundary.`).join('\n\n')

const DOCUMENT = `# Guide

Introduction.

${filler}

## One

First body.

### Detail

Detailed body.

## Two

End.

${filler}
`

let value: Scenario
test.afterEach(async () => { await value?.dispose() })

test('walkthrough progress, inclusion, markers, exact restoration, and restart stay private', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, DOCUMENT, 'walkthrough.md')
  const page = await value.launch()
  const navigation = page.getByRole('tablist', { name: 'Document navigation' })
  await navigation.getByRole('tab', { name: 'Contents' }).click()
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  const controls = page.getByLabel('Walkthrough controls')
  await expect(controls).toContainText('Section 1 of 2')
  await expect(navigation.getByRole('tab', { name: 'Contents' })).toHaveAttribute('aria-selected', 'true')

  await controls.getByRole('radio', { name: 'H2 + H3' }).click()
  await expect(controls).toContainText('Section 1 of 3')
  await page.getByRole('checkbox', { name: 'Include Detail in walkthrough' }).click()
  await expect(controls).toContainText('Section 1 of 2')
  await controls.getByRole('button', { name: 'Next' }).click()
  await expect(controls).toContainText('Section 2 of 2')
  await expect(page.getByRole('button', { name: /Two/ })).toHaveAttribute('aria-current', 'location')

  // Reviewed and Revisit live in the center-bottom walkthrough bar; Contents shows the resulting state.
  const bar = page.getByRole('group', { name: 'Walkthrough progress' })
  await expect(bar).toContainText('02 / 02')
  await bar.getByRole('button', { name: 'Reviewed' }).click()
  await expect(page.getByRole('button', { name: /Two Reviewed/ })).toBeVisible()
  const changed = DOCUMENT.replace('End.', 'Changed end.')
  await setSource(page, changed)
  await value.waitForBuffer(changed)
  await expect(page.getByRole('button', { name: /Two Revisit/ })).toBeVisible()
  await setSource(page, DOCUMENT)
  await value.waitForBuffer(DOCUMENT)
  await expect(page.getByRole('button', { name: /Two Reviewed/ })).toBeVisible()

  await bar.getByRole('button', { name: 'Revisit' }).click()
  await expect(page.getByRole('button', { name: /Two Revisit/ })).toBeVisible()
  await value.stop()

  const restarted = await value.launch()
  const restoredControls = restarted.getByLabel('Walkthrough controls')
  await expect(restoredControls).toContainText('Section 2 of 2')
  await expect(restarted.getByRole('checkbox', { name: 'Include Detail in walkthrough' })).not.toBeChecked()
  await expect(restarted.getByRole('button', { name: /Two Revisit/ })).toBeVisible()
  await restoredControls.getByRole('button', { name: 'Leave walkthrough' }).click()
  await expect(restoredControls).toBeHidden()
  await expect(restarted.getByRole('group', { name: 'Walkthrough progress' })).toHaveCount(0)
  await expect(restarted.getByRole('button', { name: 'Start walkthrough' })).toBeVisible()
  expect(await readFile(value.file, 'utf8')).toBe(DOCUMENT)
})

test('excluding every step leaves a recoverable empty walkthrough', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, '## One\n\nBody.\n')
  const page = await value.launch()
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
  await page.getByRole('button', { name: 'Start walkthrough' }).click()
  await page.getByRole('checkbox', { name: 'Include One in walkthrough' }).click()
  const controls = page.getByLabel('Walkthrough controls')
  await expect(controls).toContainText('No sections included')
  await expect(controls.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await expect(controls.getByRole('button', { name: 'Next' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Include One in walkthrough' }).click()
  await expect(controls).toContainText('Section 1 of 1')
})
