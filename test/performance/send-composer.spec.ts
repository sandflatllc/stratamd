import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { Scenario, setSource } from '../e2e/harness'

declare global {
  interface Window {
    __sendComposerLongTasks?: number[]
    __sendComposerObserver?: PerformanceObserver
  }
}

test('note typing does not rerender a 250-item Send checklist', async ({}, testInfo) => {
  const original = Array.from({ length: 250 }, (_, index) => `Paragraph ${index}.\n\nDivider ${index}.`).join('\n\n')
  const changed = Array.from({ length: 250 }, (_, index) => `External **paragraph ${index}**.\n\nDivider ${index}.`).join('\n\n')
  const scenario = await Scenario.create(testInfo, `# Large review\n\n${original}\n`, 'send-composer.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    const state = await scenario.state()
    expect(state.buffer).toBeTruthy()
    await scenario.tag('agent-b', 'Agent B')
    await scenario.atomicWrite(state.buffer!, `# Large review\n\n${changed}\n`)
    await expect.poll(async () => (await scenario.changes()).segments
      ?.filter((segment) => segment.author === 'external')
      .reduce((count, segment) => count + segment.hunks.length, 0) ?? 0).toBe(250)
    await setSource(page, `# Large review\n\n${changed}\n\nOwner follow-up.\n`)

    await page.getByRole('button', { name: /^Send/i }).first().click()
    const dialog = page.getByRole('dialog', { name: /Send changes/i })
    const body = dialog.locator('.send-tab-body')
    const items = dialog.locator('.send-items')
    await expect(dialog.locator('.send-item[data-author="external"]')).toHaveCount(250)
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
    expect(result.items).toBe(250)
    expect(result.rendersAfter).toBe(result.rendersBefore)
    expect(result.longTasks).toHaveLength(0)
  } finally {
    await scenario.dispose()
  }
})
