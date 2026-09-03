import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import { Scenario } from './harness'

const at = '2026-09-03T12:00:00.000Z'

async function startEngine(): Promise<{ server: Server; origin: string; setOnline(value: boolean): void; setMessage(value: string): void }> {
  let online = true
  let message = 'Read-side conversation from T3.'
  const server = createServer((request, response) => {
    if (!online) {
      response.writeHead(503).end('offline')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.setHeader('x-t3-version', '0.0.33')
    if (request.url === '/api/orchestration/shell') {
      response.end(JSON.stringify({
        snapshotSequence: 1,
        projects: [{ id: 'p1', title: 'Cockpit project', workspaceRoot: '/tmp/cockpit', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }],
        threads: [{ id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: 't1', status: 'running', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: 'turn-1', lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false }],
        updatedAt: at,
      }))
      return
    }
    if (request.url === '/api/orchestration/threads/t1') {
      response.end(JSON.stringify({ snapshotSequence: 2, thread: { id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: 't1', status: 'running', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: 'turn-1', lastError: null, updatedAt: at }, deletedAt: null, messages: [{ id: 'm1', role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }], activities: [], checkpoints: [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: 2, threadSequence: 2 } }))
      return
    }
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake engine did not bind')
  return { server, origin: `http://127.0.0.1:${address.port}`, setOnline: (value) => { online = value }, setMessage: (value) => { message = value } }
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
