import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { inferQuestions, inferredMessageItems } from '../../src/core/inference'

describe('prose inference', () => {
  it('finds exactly the seven question-mark list entries in the interview corpus', async () => {
    const text = await readFile(new URL('../corpus/messages/interview-seven-questions.md', import.meta.url), 'utf8')
    const questions = inferQuestions('interview', text)
    expect(questions).toHaveLength(7)
    expect(questions.map((question) => question.text)).toEqual([
      'Which audience should lead?', 'Should the launch be public?', 'What is the budget ceiling?', 'Which region goes first?',
      'Do we keep the old name?', 'Should access require approval?', 'When should the work begin?',
    ])
  })

  it('infers only completed assistant messages and explicit items suppress the same passage', () => {
    const message = { id: 'm1', role: 'assistant' as const, text: 'Ready. Which path?', turnId: 't1', streaming: false, createdAt: '', attachmentCount: 0 }
    const inferred = inferredMessageItems(message, 'thread')
    expect(inferred).toMatchObject([{ inferred: true, text: 'Which path?', messageId: 'm1' }])
    expect(inferredMessageItems(message, 'thread', [{ ...inferred[0]!, id: 'explicit', inferred: false }])).toEqual([])
    expect(inferredMessageItems({ ...message, streaming: true }, 'thread')).toEqual([])
  })
})
