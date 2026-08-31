import { expect, test, type Page } from '@playwright/test'
import { basename, dirname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { Scenario, save, send } from '../e2e/harness'
import { interactionViolations } from './budgets'
import { generateCorpus, writeCorpusAssets } from './corpus'
import { aggregateRendererSnapshots, installRendererProbe, measureAction, ProcessSampler } from './metrics'
import { attachReport, environmentDetails } from './report'
import type { ActionMeasurement, CorpusShape, PerformanceRunReport } from './types'

const profile = process.env.STRATAMD_PERF_PROFILE === 'stress' ? 'stress' : 'smoke'

interface SendDiagnosticRecord {
  at: number
  type: string
  disabled: boolean | null
  text: string
}

async function installSendDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & { __strataSendDiagnostics?: SendDiagnosticRecord[] }
    const records: SendDiagnosticRecord[] = []
    target.__strataSendDiagnostics = records
    const record = (type: string, element: Element | null) => {
      const button = element?.closest<HTMLButtonElement>('.composer-send') ?? document.querySelector<HTMLButtonElement>('.composer-send')
      records.push({
        at: performance.now(),
        type,
        disabled: button?.disabled ?? null,
        text: button?.textContent?.trim() ?? '',
      })
    }
    for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
      document.addEventListener(type, (event) => {
        const element = event.target instanceof Element ? event.target : null
        if (element?.closest('.composer-send')) record(type, element)
      }, true)
    }
    window.addEventListener('unhandledrejection', (event) => {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason)
      record(`unhandledrejection:${message}`, null)
    })
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
        const button = element?.closest<HTMLButtonElement>('.composer-send')
          ?? (element instanceof HTMLElement ? element.querySelector<HTMLButtonElement>('.composer-send') : null)
        if (button) record(`mutation:${mutation.type}:${mutation.attributeName ?? ''}`, button)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] })
  })
}

function requestedCases(): Array<{ shape: CorpusShape; bytes: number }> {
  const explicitSizes = process.env.STRATAMD_PERF_SIZES?.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0)
  const explicitShapes = process.env.STRATAMD_PERF_SHAPES?.split(',').map((value) => value.trim()).filter(Boolean) as CorpusShape[] | undefined
  if (explicitSizes?.length) {
    const shapes: CorpusShape[] = explicitShapes?.length ? explicitShapes : ['rich']
    return shapes.flatMap((shape) => explicitSizes.map((bytes) => ({ shape, bytes })))
  }
  if (profile === 'smoke') return [{ shape: 'rich', bytes: 10_000 }, { shape: 'rich', bytes: 100_000 }]
  return [
    ...[10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000].map((bytes) => ({ shape: 'rich' as const, bytes })),
    { shape: 'plain', bytes: 2_000_000 },
    { shape: 'block-heavy', bytes: 250_000 },
    { shape: 'table-heavy', bytes: 250_000 },
    { shape: 'list-heavy', bytes: 250_000 },
    { shape: 'code-heavy', bytes: 250_000 },
  ]
}

for (const performanceCase of requestedCases()) {
  test(`${profile} ${performanceCase.shape} ${performanceCase.bytes} bytes`, async ({}, testInfo) => {
    test.setTimeout(profile === 'stress' ? 8 * 60_000 : 3 * 60_000)
    const actionTimeout = profile === 'stress' ? 120_000 : 15_000
    const corpus = generateCorpus(performanceCase.shape, performanceCase.bytes)
    const value = await Scenario.create(testInfo, corpus.markdown, `${performanceCase.shape}-${corpus.manifest.bytes}.md`)
    const actions: ActionMeasurement[] = []
    let readyMs = 0
    let sampler: ProcessSampler | null = null
    let processSummary = { samples: 0, peakWorkingSetMB: 0, endingWorkingSetMB: 0, averageCpuPercent: 0, peakCpuPercent: 0, averageCpuByType: {}, peakWorkingSetByTypeMB: {} }
    let environment: PerformanceRunReport['environment'] | null = null
    let failure: PerformanceRunReport['failure'] = null
    let thrown: unknown
    let activeStage = 'launch'
    const startedAt = new Date()

    try {
      await writeCorpusAssets(value.file)
      const launchStarted = performance.now()
      const page = await value.launch()
      const editor = page.getByRole('textbox', { name: /document editor/i })
      await expect(editor).toBeVisible({ timeout: profile === 'stress' ? 120_000 : 30_000 })
      readyMs = performance.now() - launchStarted
      environment = await environmentDetails(value.app!)
      await installRendererProbe(page)
      sampler = new ProcessSampler(value.app!, 500)
      await sampler.start()

      await expect(page.getByRole('button', { name: /source/i })).toBeEnabled()
      await expect(page.getByRole('status').filter({ hasText: /size ceiling|source view only/i })).toHaveCount(0)
      await expect(editor).toContainText(corpus.firstHeading)

      const documents = dirname(value.file)
      const second = join(documents, 'performance-side-note.md')
      const third = join(documents, 'performance-checklist.md')
      await Promise.all([
        writeFile(second, '# Performance side note\n\nSmall tab used for switching.\n'),
        writeFile(third, '# Performance checklist\n\n- [ ] Return to the loaded fixture\n'),
      ])
      await page.evaluate((path) => window.strata.openDocument(path), second)
      await page.evaluate((path) => window.strata.openDocument(path), third)
      activeStage = 'tab-switch-large'
      actions.push(await measureAction(page, 'tab-switch-large', async () => {
        await page.locator('.tabs .tab').filter({ hasText: basename(value.file) }).click()
        await expect(editor).toBeVisible({ timeout: 60_000 })
        await expect(editor).toContainText(corpus.firstHeading, { timeout: 60_000 })
      }))

      activeStage = 'scroll-full-document'
      actions.push(await measureAction(page, 'scroll-full-document', async () => {
        const scroll = page.locator('.editor-scroll')
        await scroll.evaluate((node) => new Promise<void>((resolve) => {
          const maximum = node.scrollHeight - node.clientHeight
          const animate = (from: number, to: number, durationMs: number, done: () => void) => {
            const started = performance.now()
            const step = (now: number) => {
              const progress = Math.min(1, (now - started) / durationMs)
              node.scrollTop = from + (to - from) * progress
              if (progress < 1) requestAnimationFrame(step)
              else done()
            }
            requestAnimationFrame(step)
          }
          animate(0, maximum, 400, () => animate(maximum, 0, 400, resolve))
        }))
      }))

      const edited = corpus.markdown.replace(`# ${corpus.firstHeading}`, `# ${corpus.firstHeading} measured`)
      const buffer = (await value.state()).buffer!
      await editor.focus()
      await editor.evaluate((root) => {
        const heading = root.querySelector('h1')
        if (!heading) throw new Error('The performance fixture heading is missing')
        const range = document.createRange()
        range.selectNodeContents(heading)
        range.collapse(false)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })
      await page.waitForTimeout(50)
      activeStage = 'type-heading-paint'
      actions.push(await measureAction(page, 'type-heading-paint', async () => {
        await page.keyboard.insertText(' measured')
      }))
      activeStage = 'input-to-buffer-durable'
      const durability = await measureAction(page, 'input-to-buffer-durable', async () => {
        await expect.poll(() => readFile(buffer, 'utf8'), { timeout: actionTimeout }).toBe(edited)
      })
      durability.durationMs += actions.at(-1)?.durationMs ?? 0
      actions.push(durability)

      activeStage = 'toggle-source-roundtrip'
      actions.push(await measureAction(page, 'toggle-source-roundtrip', async () => {
        await page.evaluate((path) => window.strata.setSourceMode(path, true), value.file)
        const sourceEditor = page.getByRole('textbox', { name: /source editor/i })
        await expect(sourceEditor).toBeVisible({ timeout: actionTimeout })
        await expect(sourceEditor).toHaveValue(edited, { timeout: actionTimeout })
        await expect(page.locator('.strata-source-mirror')).toContainText(corpus.terminalMarker, { timeout: actionTimeout })
        await page.evaluate((path) => window.strata.setSourceMode(path, false), value.file)
        await expect(editor).toBeVisible({ timeout: actionTimeout })
      }))

      const annotationQuote = `Fixture seed: ${corpus.manifest.seed}.`
      const annotationFrom = edited.indexOf(annotationQuote)
      activeStage = 'add-annotation'
      actions.push(await measureAction(page, 'add-annotation', async () => {
        await page.evaluate(async ({ path, quote, from }) => {
          await window.strata.addAnnotation(path, { kind: 'comment', quote, text: 'Performance annotation.', from, to: from + quote.length })
        }, { path: value.file, quote: annotationQuote, from: annotationFrom })
        await expect.poll(() => page.evaluate(async (path) => {
          const state = await window.strata.getState()
          return state.activeDocument?.path === path && state.activeDocument.annotations.some((annotation) => annotation.text === 'Performance annotation.')
        }, value.file), { timeout: actionTimeout }).toBe(true)
        await expect.poll(() => page.locator('[data-annotation-id]').count(), { timeout: actionTimeout }).toBeGreaterThan(0)
      }))

      const initialDelivery = await value.attach('performance-agent', 'Performance Agent')
      expect(initialDelivery.event).toBe('initial')
      expect(initialDelivery.text).toContain('measured')
      await value.tag('performance-agent', 'Performance Agent')
      const externallyEdited = edited.replace(annotationQuote, `${annotationQuote} Agent-observed.`)
      activeStage = 'external-edit-to-review'
      actions.push(await measureAction(page, 'external-edit-to-review', async () => {
        await value.atomicWrite(buffer, externallyEdited)
        await expect(page.getByRole('button', { name: /^Keep change /i }).first()).toBeVisible({ timeout: actionTimeout })
      }))

      await installSendDiagnostics(page)
      activeStage = 'send-delivery'
      actions.push(await measureAction(page, 'send-delivery', async () => {
        await send(page, { note: 'Performance workload delivery.', includeExternal: true })
        const delivery = await value.attach('performance-agent', 'Performance Agent')
        expect(delivery.event).toBe('send')
        expect(delivery.text).toContain('Performance workload delivery.')
        expect(delivery.text).toContain('Agent-observed')
      }))

      activeStage = 'save-document'
      actions.push(await measureAction(page, 'save-document', async () => {
        await save(page)
        await expect.poll(() => readFile(value.file, 'utf8'), { timeout: actionTimeout }).toBe(externallyEdited)
      }))
    } catch (error) {
      thrown = error
      failure = { stage: activeStage, message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (sampler) processSummary = await sampler.stop().catch(() => processSummary)
      if (environment && value.page) {
        const sendDiagnostics = await value.page.evaluate(() => (window as Window & { __strataSendDiagnostics?: SendDiagnosticRecord[] }).__strataSendDiagnostics ?? []).catch(() => [])
        const sendDiagnosticsPath = testInfo.outputPath('send-diagnostics.json')
        await writeFile(sendDiagnosticsPath, `${JSON.stringify(sendDiagnostics, null, 2)}\n`)
        await testInfo.attach('send-diagnostics.json', {
          path: sendDiagnosticsPath,
          contentType: 'application/json',
        })
        const renderer = aggregateRendererSnapshots(actions)
        const violations = failure ? [] : interactionViolations(readyMs, actions, renderer)
        const report: PerformanceRunReport = {
          schemaVersion: 1,
          runId: `${profile}-${performanceCase.shape}-${corpus.manifest.bytes}`,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          profile,
          environment,
          corpus: corpus.manifest,
          readyMs,
          actions,
          renderer,
          process: processSummary,
          processSamples: sampler?.samples ?? [],
          violations,
          classification: failure ? 'failed' : violations.length > 0 ? 'degraded' : 'comfortable',
          failure,
        }
        await attachReport(testInfo, report)
        if (process.env.STRATAMD_PERF_ENFORCE === '1') expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
      }
      await value.dispose()
    }
    if (thrown) throw thrown
  })
}
