import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { it } from 'vitest'
import { createStrataApplication } from '../../src/main/application'
import { GhostStore } from '../../src/main/storage'
import { SettingsStore } from '../../src/main/settings'
import { encodeViewUpdate, type SyncedView } from '../../src/shared/view-sync'
import { generateCorpus } from './corpus'
import type { CorpusShape } from './types'

/**
 * Measures how per-event cost and published-view size behave while external
 * changes stack up unreviewed. Drives the real engine directly; no Electron.
 * A flat series means cost is proportional to each event; a climbing series
 * is the compounding failure this benchmark exists to expose.
 */

const shape = (process.env.STRATAMD_PERF_SHAPES?.split(',')[0] ?? 'rich') as CorpusShape
const requestedBytes = Number(process.env.STRATAMD_PERF_SIZES?.split(',')[0] ?? 100_000)
const steps = Number(process.env.STRATAMD_PERF_STACK_STEPS ?? 50)
const annotationEvery = 5

interface StepSample {
  step: number
  externalApplyMs: number
  viewBuildMs: number
  viewBytes: number
  wireBytes: number
  pendingHunks: number
  openAnnotations: number
  rssMB: number
}

function timed<Result>(job: () => Result): { value: Result; durationMs: number } {
  const started = performance.now()
  const value = job()
  return { value, durationMs: performance.now() - started }
}

async function timedAsync<Result>(job: () => Promise<Result>): Promise<{ value: Result; durationMs: number }> {
  const started = performance.now()
  const value = await job()
  return { value, durationMs: performance.now() - started }
}

async function openFixture(markdown: string) {
  const root = await mkdtemp(join(tmpdir(), 'stratamd-stacking-'))
  const path = join(root, 'stacked.md')
  await writeFile(path, markdown)
  const store = new GhostStore({ dataDirectory: join(root, 'data') })
  const settingsStore = new SettingsStore({ configDirectory: join(root, 'config') })
  const app = await createStrataApplication({ store, settingsStore, watch: false })
  await app.openDocument(path)
  return { app, path, store }
}

function noteFor(step: number): string {
  return `Stacked agent note ${step} keeps unique-token-${step} reviewable.`
}

/** Inserts before a deterministic, spread-out section heading; headings are unique. */
function insertNote(buffer: string, step: number, sectionNumbers: readonly number[]): string {
  const section = sectionNumbers[(step * 7) % sectionNumbers.length]!
  const marker = `\n## Rich section ${section}\n`
  const at = buffer.indexOf(marker)
  if (at === -1) throw new Error(`Missing section marker for section ${section}`)
  return `${buffer.slice(0, at)}\n\n${noteFor(step)}${buffer.slice(at)}`
}

async function typingProbe(app: Awaited<ReturnType<typeof openFixture>>['app'], path: string): Promise<number> {
  const content = (await app.getState()).activeDocument!.content
  const typed = `${content.slice(0, 2)}X${content.slice(2)}`
  return (await timedAsync(() => app.updateBuffer(path, typed))).durationMs
}

async function main(): Promise<void> {
  const corpus = generateCorpus(shape, requestedBytes)
  const sectionNumbers = [...corpus.markdown.matchAll(/\n## Rich section (\d+)\n/gu)]
    .map((match) => Number(match[1]))
    .slice(1)
  if (sectionNumbers.length < 8) throw new Error('Corpus has too few sections for spread insertions')

  const baseline = await openFixture(corpus.markdown)
  const typingBaselineMs = await typingProbe(baseline.app, baseline.path)
  await baseline.app.shutdown()

  const { app, path, store } = await openFixture(corpus.markdown)
  let buffer = corpus.markdown

  // Mirrors the IPC transport: every published view is encoded against the
  // previous one, and the encoded update is what a window would receive.
  let lastSent: SyncedView | null = null
  let stepWireBytes = 0
  const unsubscribe = app.subscribe((view) => {
    const update = encodeViewUpdate(lastSent, (lastSent?.seq ?? 0) + 1, view, false)
    lastSent = { seq: update.seq, view }
    stepWireBytes += JSON.stringify(update).length
  })

  const samples: StepSample[] = []

  for (let step = 0; step < steps; step += 1) {
    buffer = insertNote(buffer, step, sectionNumbers)
    stepWireBytes = 0
    const external = await timedAsync(async () => {
      await store.writeBuffer(path, buffer)
      await app.recheckFocused()
    })
    const view = await timedAsync(() => app.getState())
    const document = view.value.activeDocument!

    if (step % annotationEvery === annotationEvery - 1) {
      const quote = noteFor(step)
      const from = document.content.indexOf(quote)
      if (from === -1) throw new Error(`Inserted note ${step} missing from document`)
      await app.addAnnotation(path, { kind: 'comment', quote, text: `Watching note ${step}.`, from, to: from + quote.length })
    }

    samples.push({
      step,
      externalApplyMs: external.durationMs,
      viewBuildMs: view.durationMs,
      viewBytes: JSON.stringify(view.value).length,
      wireBytes: stepWireBytes,
      pendingHunks: document.pendingHunks.length,
      openAnnotations: document.annotations.filter((annotation) => annotation.status !== 'resolved').length,
      rssMB: process.memoryUsage().rss / 1024 / 1024,
    })
    process.stdout.write(`${JSON.stringify(samples.at(-1))}\n`)
  }

  const typingStackedMs = await typingProbe(app, path)
  unsubscribe()
  await app.shutdown()

  const head = samples.slice(0, 5)
  const tail = samples.slice(-5)
  const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const summary = {
    schemaVersion: 1,
    corpus: corpus.manifest,
    steps,
    firstFive: {
      externalApplyMs: average(head.map((sample) => sample.externalApplyMs)),
      viewBuildMs: average(head.map((sample) => sample.viewBuildMs)),
      viewBytes: average(head.map((sample) => sample.viewBytes)),
      wireBytes: average(head.map((sample) => sample.wireBytes)),
    },
    lastFive: {
      externalApplyMs: average(tail.map((sample) => sample.externalApplyMs)),
      viewBuildMs: average(tail.map((sample) => sample.viewBuildMs)),
      viewBytes: average(tail.map((sample) => sample.viewBytes)),
      wireBytes: average(tail.map((sample) => sample.wireBytes)),
    },
    typingBaselineMs,
    typingStackedMs,
    finalPendingHunks: samples.at(-1)!.pendingHunks,
    finalOpenAnnotations: samples.at(-1)!.openAnnotations,
    finalRssMB: samples.at(-1)!.rssMB,
  }
  process.stdout.write(`${JSON.stringify({ summary })}\n`)

  const outDir = join('test-results', 'performance', 'stacking')
  await mkdir(outDir, { recursive: true })
  const runId = process.env.STRATAMD_PERF_RUN_ID ?? 'latest'
  await writeFile(
    join(outDir, `${runId}.json`),
    `${JSON.stringify({ summary, samples }, null, 2)}\n`,
  )
}

it('measures stacked external changes', { timeout: 600_000 }, main)
