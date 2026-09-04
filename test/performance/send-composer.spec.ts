import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { setSource } from '../e2e/harness'
import { seededScenario, startEngine } from '../e2e/cockpit-engine-harness'
import { agentActs, attachThread, openThread } from '../e2e/cockpit-agent'

declare global {
  interface Window {
    __sendComposerLongTasks?: number[]
    __sendComposerObserver?: PerformanceObserver
  }
}

test('note typing does not rerender a 250-item Send checklist', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const count = 250
  const original = Array.from({ length: count }, (_, index) => `Paragraph ${index}.\n\nDivider ${index}.`).join('\n\n')
  const changed = Array.from({ length: count }, (_, index) => `External **paragraph ${index}**.\n\nDivider ${index}.`).join('\n\n')
  const engine = await startEngine({ titles: { t1: 'Agent A', t2: 'Agent B' } })
  const scenario = await seededScenario(testInfo, engine.origin, `# Large review\n\n${original}\n`, 'send-composer.md')
  try {
    const page = await scenario.launch()
    for (const [id, title] of [['t1', 'Agent A'], ['t2', 'Agent B']] as const) {
      await openThread(page, title)
      await attachThread(page, id, title)
    }
    await openThread(page, 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    // Agent B rewrites every paragraph in one message (§5.9).
    agentActs(engine, 't2', Array.from({ length: count }, (_, index) => ({ verb: 'edit', anchor: { document: scenario.file, quote: `Paragraph ${index}.` }, match: `Paragraph ${index}.`, replace: `External **paragraph ${index}**.` })))
    await expect.poll(async () => (await scenario.inspectDocument()).segments
      ?.filter((segment) => segment.author === 'external')
      .reduce((total, segment) => total + segment.hunks.length, 0) ?? 0, { timeout: 60_000 }).toBe(count)
    await setSource(page, `# Large review\n\n${changed}\n\nOwner follow-up.\n`)

    await page.getByRole('button', { name: /^Send/i }).first().click()
    const dialog = page.getByRole('dialog', { name: /Send changes/i })
    await dialog.getByRole('checkbox', { name: 'Agent A' }).check()
    await dialog.getByRole('tab', { name: 'Agent A' }).click()
    const body = dialog.locator('.send-tab-body')
    const items = dialog.locator('.send-items')
    await expect(dialog.locator('.send-item[data-author="external"]')).toHaveCount(count)
    await expect(body).toHaveAttribute('aria-busy', 'false')
    const rendersBefore = Number(await items.getAttribute('data-render'))

    await page.evaluate(() => {
      window.__sendComposerLongTasks = []
      window.__sendComposerObserver = new PerformanceObserver((list) => {
        window.__sendComposerLongTasks!.push(...list.getEntries().map((entry) => entry.duration))
      })
      window.__sendComposerObserver.observe({ entryTypes: ['longtask'] })
    })

    const inputToNextPaintMs = await dialog.getByRole('textbox', { name: /Note for recipients/i }).evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      return new Promise<number>((resolve) => {
        const started = performance.now()
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(textarea, 'Measured note')
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Measured note', inputType: 'insertText' }))
        requestAnimationFrame(() => resolve(performance.now() - started))
      })
    })
    await expect(body).toHaveAttribute('aria-busy', 'false')
    await page.waitForTimeout(100)
    const result = await page.evaluate(({ inputToNextPaintMs, rendersBefore }) => {
      window.__sendComposerObserver?.disconnect()
      const longTasks = window.__sendComposerLongTasks ?? []
      const rendersAfter = Number(document.querySelector('.send-items')?.getAttribute('data-render'))
      return {
        items: document.querySelectorAll('.send-item[data-author="external"]').length,
        inputToNextPaintMs,
        rendersBefore,
        rendersAfter,
        longTasks,
        maxLongTaskMs: Math.max(0, ...longTasks),
      }
    }, { inputToNextPaintMs, rendersBefore })

    const output = testInfo.outputPath('send-composer-performance.json')
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
    await testInfo.attach('send-composer-performance.json', { path: output, contentType: 'application/json' })
    expect(result.items).toBe(count)
    expect(result.rendersAfter).toBe(result.rendersBefore)
    expect(result.longTasks).toHaveLength(0)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
