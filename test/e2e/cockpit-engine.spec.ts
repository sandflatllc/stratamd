import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import { Scenario } from './harness'
import { mapMarkdownBlocks } from '../../src/core/blocks'

const at = '2026-09-03T12:00:00.000Z'

async function startEngine(): Promise<{ server: Server; origin: string; commands: Array<Record<string, unknown>>; setOnline(value: boolean): void; setMessage(value: string): void; finish(): void }> {
  let online = true
  let message = 'Read-side conversation from T3.'
  let status: 'running' | 'stopped' = 'running'
  let approvalOpen = true
  let inputOpen = true
  const commands: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    if (!online) {
      response.writeHead(503).end('offline')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.setHeader('x-t3-version', '0.0.33')
    if (request.url === '/api/orchestration/dispatch' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        commands.push(command)
        if (command.type === 'thread.turn.start') status = 'running'
        if (command.type === 'thread.turn.interrupt') status = 'stopped'
        if (command.type === 'thread.approval.respond') approvalOpen = false
        if (command.type === 'thread.user-input.respond') inputOpen = false
        response.end(JSON.stringify({ sequence: commands.length + 2 }))
      })
      return
    }
    if (request.url === '/api/orchestration/shell') {
      response.end(JSON.stringify({
        snapshotSequence: 1,
        projects: [{ id: 'p1', title: 'Cockpit project', workspaceRoot: '/tmp/cockpit', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }],
        threads: [{ id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: { turnId: 'turn-1', state: status === 'running' ? 'running' : 'interrupted', requestedAt: at, startedAt: at, completedAt: null, assistantMessageId: 'm1' }, createdAt: at, updatedAt: at, session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: approvalOpen, hasPendingUserInput: inputOpen, hasActionableProposedPlan: false }],
        updatedAt: at,
      }))
      return
    }
    if (request.url === '/api/orchestration/threads/t1') {
      const activities = [
        ...(approvalOpen ? [{ id: 'a1', tone: 'approval', kind: 'approval.requested', summary: 'Command approval requested', payload: { requestId: 'approval-1', detail: 'Run the cockpit verification?' }, turnId: 'turn-1', createdAt: at }] : [{ id: 'a2', tone: 'approval', kind: 'approval.resolved', summary: 'Approval resolved', payload: { requestId: 'approval-1' }, turnId: 'turn-1', createdAt: at }]),
        ...(inputOpen ? [{ id: 'u1', tone: 'info', kind: 'user-input.requested', summary: 'User input requested', payload: { requestId: 'input-1', questions: [{ id: 'release', question: 'Which release?', options: [{ label: 'Version one' }] }] }, turnId: 'turn-1', createdAt: at }] : [{ id: 'u2', tone: 'info', kind: 'user-input.resolved', summary: 'User input submitted', payload: { requestId: 'input-1' }, turnId: 'turn-1', createdAt: at }]),
        { id: 'tool-1', tone: 'tool', kind: 'tool.completed', summary: 'Updated cockpit files', payload: {}, turnId: 'turn-1', createdAt: at },
      ]
      const sent = commands.filter((command) => command.type === 'thread.turn.start').map((command, index) => ({ id: `sent-${index}`, role: 'user', text: (command.message as { text: string }).text, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }))
      response.end(JSON.stringify({ snapshotSequence: commands.length + 2, thread: { id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: { turnId: 'turn-1', state: status === 'running' ? 'running' : 'interrupted', requestedAt: at, startedAt: at, completedAt: null, assistantMessageId: 'm1' }, createdAt: at, updatedAt: at, session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, deletedAt: null, messages: [...sent, { id: 'm1', role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: status === 'running', createdAt: at, updatedAt: at }], activities, checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: commands.length + 2, threadSequence: commands.length + 2 } }))
      return
    }
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake engine did not bind')
  return { server, origin: `http://127.0.0.1:${address.port}`, commands, setOnline: (value) => { online = value }, setMessage: (value) => { message = value }, finish: () => { status = 'stopped' } }
}

async function seededScenario(testInfo: TestInfo, origin: string): Promise<Scenario> {
  const scenario = await Scenario.create(testInfo, '# Engine-safe document\n\nKeep editing while the engine is down.\n', 'cockpit-engine.md')
  const directory = join(String(scenario.env.XDG_DATA_HOME), 'stratamd')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'engine-credential.json'), `${JSON.stringify({ formatVersion: 1, server: origin, accessToken: 'test-session', expiresAt: Date.now() + 3_600_000 })}\n`, { mode: 0o600 })
  return scenario
}

test('1 and 2 read side: disconnect is isolated and reconnect restores the active live conversation', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByRole('button', { name: /Live engine thread/ })).toBeVisible()
    await page.getByRole('button', { name: /Live engine thread/ }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Read-side conversation from T3.')

    engine.setOnline(false)
    await expect(page.getByTestId('conversation-disconnected')).toBeVisible({ timeout: 2_000 })
    await navigation.getByRole('tab', { name: 'Contents' }).click()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' Still here.')
    await expect(editor).toContainText('Still here.')
    await page.waitForTimeout(250)

    engine.setMessage('Conversation restored after reconnect.')
    engine.setOnline(true)
    await navigation.getByRole('tab', { name: 'Conversation' }).click()
    await page.getByRole('button', { name: 'Reconnect' }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Conversation restored after reconnect.')
    expect(await page.evaluate(async () => (await window.strata.getState()).activeDocument?.content)).toContain('Still here.')
  } finally {
    await scenario.dispose()
    await new Promise<void>((resolve) => engine.server.close(() => resolve()))
  }
})

test('2 conversation: moves between placements and dispatches a message, approval, user input, and Stop', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /Live engine thread/ }).click()
    const side = page.getByRole('region', { name: 'Conversation' })
    await expect(side.locator('.conversation-turn')).toHaveAttribute('data-folded', 'true')
    await expect(side.getByRole('tab', { name: 'This passage' })).toBeDisabled()
    await side.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    await expect(center).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Live engine thread/ })).toBeVisible()
    await expect(center.locator('.conversation-turn')).not.toHaveAttribute('data-folded', 'true')

    const composer = center.getByRole('textbox', { name: 'Message conversation' })
    await composer.fill('First line')
    await composer.press('Shift+Enter')
    await composer.type('Second line')
    await composer.press('Enter')
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.turn.start')).toBe(true)
    expect(engine.commands.find((command) => command.type === 'thread.turn.start')).toMatchObject({ message: { text: 'First line\nSecond line' } })

    await center.getByRole('button', { name: 'Approve' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.approval.respond')).toBe(true)
    await center.getByRole('button', { name: 'Version one' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.user-input.respond')).toBe(true)
    await center.getByRole('button', { name: 'Stop' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.turn.interrupt')).toBe(true)
    expect(engine.commands.map((command) => command.type)).toEqual(expect.arrayContaining(['thread.turn.start', 'thread.approval.respond', 'thread.user-input.respond', 'thread.turn.interrupt']))

    await center.getByRole('button', { name: 'Move to side' }).click()
    const moved = page.locator('.conversation-panel[data-placement="side"]')
    await expect(moved).toBeVisible()

    const path = (await page.evaluate(async () => (await window.strata.getState()).activeDocument?.path))!
    await page.evaluate(async ({ path }) => window.strata.addAnnotation(path, { kind: 'comment', quote: 'Engine-safe', text: 'Passage context', from: 2, to: 13 }), { path })
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotations-panel .annotation-row').filter({ hasText: 'Engine-safe' }).click()
    await expect(moved.getByRole('tab', { name: 'This passage' })).toBeEnabled()
    await expect(moved.getByRole('tab', { name: 'This passage' })).toHaveAttribute('aria-selected', 'true')
    await moved.getByRole('tab', { name: 'Whole thread' }).click()
    await expect(moved).toContainText('Read-side conversation from T3.')
  } finally {
    await scenario.dispose()
    await new Promise<void>((resolve) => engine.server.close(() => resolve()))
  }
})

test('4 explicit message item: completed agent prose has block ids and its posted item appears once', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const prose = 'The first approach is safer.\n\nThe second approach is faster.'
    const block = mapMarkdownBlocks('message:m1', prose).blocks[1]!
    engine.setMessage(`${prose}\n\n\`\`\`strata\n[{"verb":"question","anchor":{"message":"m1","block":"${block.id}"},"text":"Which approach should I take?"}]\n\`\`\``)
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /Live engine thread/ }).click()
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('button', { name: 'Stop' }).click()
    const proseNode = conversation.locator('[data-message-id="m1"] [data-annotatable="true"]')
    await expect(proseNode).toHaveAttribute('data-block-ids', new RegExp(block.id))
    await expect(conversation.getByRole('region', { name: 'Turn items' }).getByText('Which approach should I take?')).toHaveCount(1)
    await expect(conversation).not.toContainText('```strata')
  } finally {
    await scenario.dispose()
    await new Promise<void>((resolve) => engine.server.close(() => resolve()))
  }
})

test('4 inference: seven prose questions queue four keyed replies in one delivery and leave three open', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    engine.setMessage('1. Which audience should lead?\n2. Should launch be public?\n3. What is the budget?\n4. Which region goes first?\n5. Keep the old name?\n6. Require approval?\n7. When should work begin?')
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /Live engine thread/ }).click()
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('button', { name: 'Stop' }).click()
    const checklist = conversation.getByRole('region', { name: 'Turn items' })
    await expect(checklist.locator('.turn-item')).toHaveCount(7)
    await expect(checklist.getByText('inferred')).toHaveCount(7)
    for (const [index, answer] of ['Audience', 'Yes', '$10k', 'West'].entries()) {
      const row = checklist.locator('.turn-item').nth(index)
      await row.getByRole('textbox').fill(answer)
      await row.getByRole('button', { name: 'Queue reply' }).click()
    }
    await expect(checklist.locator('.turn-item[data-status="drafted"]')).toHaveCount(4)
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const text = ((engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string }).text)
    expect(text.match(/^- inferred_[^:]+:/gmu)).toHaveLength(4)
    engine.finish()
    await expect(checklist.locator('.turn-item[data-status="open"]')).toHaveCount(3)
  } finally {
    await scenario.dispose()
    await new Promise<void>((resolve) => engine.server.close(() => resolve()))
  }
})
