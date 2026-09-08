import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from './test'
import { expectActiveDocument, Scenario } from './harness'
import { openThread } from './cockpit-agent'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { pngBytes } from './png'

for (const placement of ['side', 'center'] as const) {
  test(`sister-folder images and Markdown open in ${placement} despite a missing unrelated project`, async ({}, info) => {
    const engine = await startEngine()
    const scenario = await seededScenario(info, engine.origin)
    const artifacts = join(await realpath(scenario.root), 'artifacts')
    const image = join(artifacts, 'a photo.png')
    const notes = join(artifacts, 'review.md')
    const retired = join(scenario.root, 'retired-project')
    await mkdir(artifacts)
    await mkdir(retired)
    await writeFile(image, pngBytes(120, 60))
    await writeFile(join(dirname(scenario.file), 'inside.png'), pngBytes(120, 60))
    await writeFile(notes, '# Sister-folder review\n\nReady to read.\n')
    engine.setWorkspaceRoot(dirname(scenario.file))
    engine.postAssistant('t1', `![Inside](inside.png)\n\n![Relative](../artifacts/a%20photo.png)\n\n![Absolute](<${image}>)\n\n![File URL](${pathToFileURL(image).href})\n\n[Read review](${notes})`)
    try {
      const page = await scenario.launch()
      await page.evaluate(workspaceRoot => window.strata.createEngineProject({ title: 'Retired', workspaceRoot }), retired)
      await rm(retired, { recursive: true })
      await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).engine.projects.map(p => p.title))).toContain('Retired')
      await openThread(page, 'Live engine thread')
      if (placement === 'center') await page.getByRole('button', { name: 'Open in center', exact: true }).click()
      const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
      for (const alt of ['Inside', 'Relative', 'Absolute', 'File URL']) {
        await expect(panel.locator(`img[alt="${alt}"]`)).toHaveAttribute('data-decoded', 'true')
      }
      await panel.getByRole('link', { name: 'Read review', exact: true }).click()
      await expectActiveDocument(page, /review\.md/)
      await expect(page.getByRole('textbox', { name: 'Document editor', exact: true })).toContainText('Sister-folder review')
    } finally { await scenario.dispose(); await engine.close() }
  })
}

test('missing and undecodable images explain the failure and Retry reads the repaired file', async ({}, info) => {
  const scenario = await Scenario.create(info, '# Retry\n\n![Late image](../artifacts/late.png)\n\n![Broken image](../artifacts/broken.png)\n')
  const artifacts = join(await realpath(scenario.root), 'artifacts')
  await mkdir(artifacts)
  await writeFile(join(artifacts, 'broken.png'), 'not an image')
  try {
    const page = await scenario.launch()
    const missing = page.getByRole('group', { name: 'Late image', exact: true })
    const broken = page.getByRole('group', { name: 'Broken image', exact: true })
    await expect(missing).toContainText(`File missing: ${join(artifacts, 'late.png')}`)
    await expect(broken).toContainText('Could not read or decode image:')
    await writeFile(join(artifacts, 'late.png'), pngBytes(140, 70))
    await writeFile(join(artifacts, 'broken.png'), pngBytes(140, 70))
    await missing.getByRole('button', { name: 'Retry', exact: true }).click()
    await broken.getByRole('button', { name: 'Retry', exact: true }).click()
    for (const alt of ['Late image', 'Broken image']) {
      await expect(page.locator(`img[alt="${alt}"]`)).toHaveAttribute('data-decoded', 'true')
    }
  } finally { await scenario.dispose() }
})

test('a missing sister-folder Markdown preview names the path and retries without reopening the document', async ({}, info) => {
  const scenario = await Scenario.create(info, '# References\n\n[Plan](../artifacts/plan.md)\n')
  const artifacts = join(await realpath(scenario.root), 'artifacts')
  await mkdir(artifacts)
  try {
    const page = await scenario.launch()
    await page.getByRole('link', { name: 'Plan', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Preview ../artifacts/plan.md', exact: true })
    await expect(preview).toContainText(`File missing: ${join(artifacts, 'plan.md')}`)
    await writeFile(join(artifacts, 'plan.md'), '# Recovered plan\n\nSister-folder content.\n')
    await preview.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(preview).toContainText('Sister-folder content.')
    await preview.getByRole('button', { name: 'Open document', exact: true }).click()
    await expectActiveDocument(page, /plan\.md/)
  } finally { await scenario.dispose() }
})
