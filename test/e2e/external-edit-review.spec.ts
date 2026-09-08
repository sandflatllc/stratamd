import { expect, test } from './test'
import { readFile } from 'node:fs/promises'
import { Scenario, documentStartKey, lineEndKey, primaryKey, sourceEditor } from './harness'
import { parseMarkdown } from '../../src/core/markdown'
import { generateCorpus } from '../performance/corpus'
import type { BufferBlockRange } from '../../src/shared/contracts'

interface BufferCapture { content: string; ranges: BufferBlockRange[] | undefined }

async function captureBuffers(scenario: Scenario): Promise<void> {
  await scenario.app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('strata:update-buffer')!
    const captures: BufferCapture[] = []
    ;(globalThis as typeof globalThis & { bufferCaptures: BufferCapture[] }).bufferCaptures = captures
    handlers.set('strata:update-buffer', async (...args) => {
      captures.push({ content: args[2] as string, ranges: args[4] as BufferBlockRange[] })
      return original(...args)
    })
  })
}

async function expectExactSnapshot(scenario: Scenario, content: string): Promise<void> {
  const captures = await scenario.app!.evaluate(() => (globalThis as typeof globalThis & { bufferCaptures: BufferCapture[] }).bufferCaptures)
  const snapshot = captures.findLast((capture) => capture.content === content)
  expect(snapshot?.ranges).toEqual(parseMarkdown(content).blocks.map(({ span }) => ({ from: span.start.offset, to: span.end.offset })))
}

for (const position of ['top', 'bottom'] as const) {
  test(`external ${position} edit after typing keeps exact ranges and has no parse divergence`, async ({}, testInfo) => {
    const original = generateCorpus('table-heavy', 12_000).markdown
    const scenario = await Scenario.create(testInfo, original, 'tables.md')
    try {
      const page = await scenario.launch()
      await captureBuffers(scenario)
      const errors: string[] = []
      page.on('console', (message) => { if (message.type() === 'error' && message.text().includes('diverged')) errors.push(message.text()) })
      const editor = page.getByRole('textbox', { name: 'Document editor', exact: true })
      await editor.focus()
      await page.keyboard.press(documentStartKey)
      await page.keyboard.press(lineEndKey)
      await page.keyboard.insertText(' measured')
      const headingEnd = original.indexOf('\n')
      const typed = `${original.slice(0, headingEnd)} measured${original.slice(headingEnd)}`
      await scenario.waitForBuffer(typed)
      await expectExactSnapshot(scenario, typed)

      const parsed = parseMarkdown(typed)
      const target = position === 'top'
        ? parsed.blocks.find((block) => block.node.type === 'paragraph')!
        : parsed.blocks.findLast((block) => block.node.type === 'table')!
      const at = position === 'top' ? target.span.end.offset : target.span.end.offset - 2
      const changed = `${typed.slice(0, at)} external sentence${typed.slice(at)}`
      const { buffer } = await scenario.inspectDocument()
      await scenario.atomicWrite(buffer!, changed)
      await expect(page.locator('button[aria-label^="Keep change"]').first()).toBeVisible()
      await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).activeDocument?.content).toBe(changed)
      const stats = await page.evaluate(() => {
        const stats = (globalThis as typeof globalThis & { strataReparseStats: { stitched: number; fallbacks: Record<string, number> } }).strataReparseStats
        return { stitched: stats.stitched, divergence: stats.fallbacks['verify-divergence'] ?? 0 }
      })
      expect(stats.stitched).toBeGreaterThan(0)
      expect(stats.divergence).toBe(0)
      expect(errors).toEqual([])
      await page.keyboard.press(primaryKey('s'))
      await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).activeDocument?.dirty).toBe(false)
      expect(await readFile(scenario.file, 'utf8')).toBe(changed)
    } finally { await scenario.dispose() }
  })
}

test('source typing followed by an immediate save sends ranges for the saved text', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Original\n\nParagraph.\n\nTail.\n')
  try {
    const page = await scenario.launch()
    await captureBuffers(scenario)
    const source = await sourceEditor(page)
    const changed = '# 😀 Changed\n\nFirst paragraph.\n\nSecond paragraph.\n\nTail.\n'
    await source.fill(changed)
    await page.keyboard.press(primaryKey('s'))
    await scenario.waitForBuffer(changed)
    await expectExactSnapshot(scenario, changed)
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { strataReparseStats: { fallbacks: Record<string, number> } }).strataReparseStats.fallbacks['verify-divergence'] ?? 0)).toBe(0)
  } finally { await scenario.dispose() }
})
