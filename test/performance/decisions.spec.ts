import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import {
  annotationDeliverySlice,
  answerDecision,
  createAnnotation,
  createAnnotationLog,
  reopenDecision,
} from '../../src/core/annotations'
import { createPayload } from '../../src/core/payload'
import { filteredAnnotations } from '../../src/renderer/model'
import type { AnnotationView, DocumentView } from '../../src/shared/contracts'

test('100 decisions with answer history stay below 100 ms', async ({}, testInfo) => {
  let log = createAnnotationLog()
  for (let index = 0; index < 100; index += 1) {
    const id = `decision-${index}`
    log = createAnnotation(log, '# Decisions\n', {
      id,
      kind: 'decision',
      author: 'user',
      quote: '',
      text: `Choose release path ${index}`,
      options: ['Use CI', 'Manual review'],
      anchorKind: 'document',
      createdAt: index,
    }).log
    log = answerDecision(log, id, { option: 'Use CI', answeredAt: index + 100 }).log
    log = reopenDecision(log, id).log
    log = answerDecision(log, id, { option: null, other: `Exception ${index}`, answeredAt: index + 200 }).log
    log = reopenDecision(log, id).log
  }

  const projected: AnnotationView[] = Object.values(log.annotations).map((annotation) => ({
    id: annotation.id,
    seq: annotation.seq,
    kind: 'decision',
    status: annotation.status,
    anchor: annotation.anchor.kind ?? 'quote',
    author: 'user',
    quote: annotation.quote,
    text: annotation.text,
    line: annotation.line,
    from: annotation.anchor.kind === 'document' ? null : annotation.anchor.start,
    to: annotation.anchor.kind === 'document' ? null : annotation.anchor.end,
    decision: annotation.decision!,
    replies: [],
  }))
  const document: DocumentView = {
    path: '/tmp/decisions.md', bufferPath: '/tmp/buffer.md', leadAgentId: null,
    content: '# Decisions\n', reading: { formatVersion: 4, navigationTab: 'contents', reviewTab: 'annotations', walkthrough: { active: false, level: 'h2', current: null, excluded: [], markers: [] }, tables: [], foldedHeadings: [] },
    sourceMode: false, sourceOnly: false, readOnly: false, dirty: false, deleted: false, invalidUtf8: false,
    problems: [], lastSavedAt: null, historyStep: 0, pendingHunks: [], saves: [], annotations: projected, drafts: [],
    attachments: [], recipients: [], canSend: false, conflicts: [],
  }

  const measure = () => {
    const filterStarted = performance.now()
    for (const filter of ['all', 'decisions', 'questions', 'comments', 'suggestions', 'resolved'] as const) {
      filteredAnnotations(document, filter)
    }
    const filteringMs = performance.now() - filterStarted

    const answerStarted = performance.now()
    answerDecision(log, 'decision-50', { option: 'Manual review', answeredAt: 1_000 })
    const answeringMs = performance.now() - answerStarted

    const payloadStarted = performance.now()
    const slice = annotationDeliverySlice(log, 0, 'ag_perf')
    createPayload({
      file: document.path,
      buffer: document.bufferPath,
      agent: 'ag_perf',
      event: 'send',
      cursor: slice.cursor,
      annotations: slice.annotations,
      replies: slice.replies,
      answers: slice.answers,
      resolved: slice.resolved,
    })
    const payloadMs = performance.now() - payloadStarted
    return { filteringMs, answeringMs, payloadMs }
  }

  measure()
  const samples = Array.from({ length: 5 }, measure)
  const result = { decisions: projected.length, answersPerDecision: 2, samples }
  const path = testInfo.outputPath('decisions-performance.json')
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  await testInfo.attach('decisions-performance.json', { path, contentType: 'application/json' })

  expect(result.decisions).toBe(100)
  expect(samples.every((sample) => sample.filteringMs < 100)).toBe(true)
  expect(samples.every((sample) => sample.answeringMs < 100)).toBe(true)
  expect(samples.every((sample) => sample.payloadMs < 100)).toBe(true)
})
