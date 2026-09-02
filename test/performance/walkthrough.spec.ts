import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { WalkthroughState } from '../../src/shared/contracts'
import { applyWalkthroughAction, buildWalkthroughIndex, updateWalkthroughIndex } from '../../src/main/walkthrough'
import { generateCorpus } from './corpus'

interface WalkthroughPerformanceSample {
  bytes: number
  sections: number
  durationsMs: number[]
  hashedSections: number[]
  rebuilt: boolean[]
}

test('walkthrough updates one section in a >2 MB document', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const corpus = generateCorpus('rich', 2_100_000)
  const index = buildWalkthroughIndex(corpus.markdown)
  const section = index.sections[Math.floor(index.sections.length / 2)]!
  const editAt = corpus.markdown.indexOf('deterministic', section.headingTo)
  expect(editAt).toBeGreaterThan(section.headingTo)
  expect(editAt).toBeLessThan(section.sourceTo)

  const empty: WalkthroughState = { active: true, level: 'h2', current: section.reference, excluded: [], markers: [] }
  const state = applyWalkthroughAction(empty, { type: 'mark', heading: section.reference, status: 'reviewed' }, index)
  const variants = ['D', 'E', 'F'].map((replacement) =>
    `${corpus.markdown.slice(0, editAt)}${replacement}${corpus.markdown.slice(editAt + 1)}`,
  )

  // Warm the function once so this measures update work rather than module setup.
  updateWalkthroughIndex(index, variants[0]!, state)
  const updates = variants.map((markdown) => updateWalkthroughIndex(index, markdown, state))
  const sample: WalkthroughPerformanceSample = {
    bytes: corpus.manifest.bytes,
    sections: index.sections.length,
    durationsMs: updates.map((update) => update.durationMs),
    hashedSections: updates.map((update) => update.hashedSections),
    rebuilt: updates.map((update) => update.rebuilt),
  }
  const path = testInfo.outputPath('walkthrough-performance.json')
  await writeFile(path, `${JSON.stringify(sample, null, 2)}\n`)
  await testInfo.attach('walkthrough-performance.json', { path, contentType: 'application/json' })

  expect(sample.bytes).toBeGreaterThan(2_000_000)
  expect(sample.sections).toBeGreaterThan(100)
  expect(sample.durationsMs.every((duration) => duration < 50)).toBe(true)
  expect(sample.hashedSections).toEqual([1, 1, 1])
  expect(sample.rebuilt).toEqual([false, false, false])
  expect(updates.map((update) => update.state.markers[0]?.status)).toEqual(['revisit', 'revisit', 'revisit'])
})
