import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { inferQuestions } from '../../src/core/inference'

describe('legacy inferred identities', () => {
  it('finds exactly the seven question-mark list entries in the interview corpus', async () => {
    const text = await readFile(new URL('../corpus/messages/interview-seven-questions.md', import.meta.url), 'utf8')
    const questions = inferQuestions('interview', text)
    expect(questions).toHaveLength(7)
    expect(questions.map((question) => question.text)).toEqual([
      'Which audience should lead?', 'Should the launch be public?', 'What is the budget ceiling?', 'Which region goes first?',
      'Do we keep the old name?', 'Should access require approval?', 'When should the work begin?',
    ])
  })

})
