import { seedAsks } from './inferred-asks-fixture'
import { reviewCapture } from './captures'
import { openAppMenu } from './harness'
import { expect, test } from './test'
import { mapMarkdownBlocks } from '../../src/core/blocks'
import { readFile } from 'node:fs/promises'
import { credentialPath, seededScenario, startEngine } from './cockpit-engine-harness'
import { primaryKey } from './harness'

test('1 pairing: host plus code pairs through the dialog, shows the server, and pairing again replaces the credential', async ({}, testInfo) => {
  const engine = await startEngine({ pairingCodes: ['first-code', 'second-code'] })
  const scenario = await seededScenario(testInfo, engine.origin, undefined, 'cockpit-pairing.md', { paired: false })
  try {
    const page = await scenario.launch()
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByTestId('engine-unpaired')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Pair engine/)
    await page.getByTestId('engine-unpaired').getByRole('button', { name: 'Pair engine' }).click()
    const dialog = page.getByRole('dialog', { name: 'Engine' })
    await expect(dialog.getByTestId('engine-status')).toHaveText('No engine paired')
    await dialog.getByLabel('Host').fill(engine.origin.replace('http://', ''))
    await dialog.getByLabel('Code').fill('first-code')
    await dialog.getByRole('button', { name: 'Pair', exact: true }).click()
    await expect(dialog.getByTestId('engine-status')).toHaveText('Connected')
    await expect(dialog.getByTestId('engine-server')).toHaveText(engine.origin)
    await expect(JSON.parse(await readFile(credentialPath(scenario), 'utf8'))).toMatchObject({ server: engine.origin, accessToken: 'session-for-first-code' })

    await expect(dialog.getByRole('button', { name: 'Pairing…', exact: true })).toBeHidden()
    await dialog.locator('.engine-pairing > summary').click()
    await dialog.getByLabel('Pairing link').fill(`${engine.origin}/pair?token=second-code`)
    await dialog.getByRole('button', { name: 'Pair again' }).click()
    await expect.poll(() => engine.tokenRequests).toEqual(['first-code', 'second-code'])
    await expect.poll(async () => JSON.parse(await readFile(credentialPath(scenario), 'utf8')).accessToken).toBe('session-for-second-code')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Open Live engine thread$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Connected/)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('1 and 2 read side: disconnect is isolated and reconnect restores the active live conversation', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByRole('button', { name: /^Open Live engine thread$/ })).toBeVisible()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Read-side conversation from T3.')
    // The conversation is a live subscription (§5.1): the fake engine holds one socket with a thread subscription.
    await expect.poll(() => engine.rpcRequests.filter((request) => request.tag === 'orchestration.subscribeThread').length).toBeGreaterThan(0)
    expect(engine.connections()).toBe(1)
    engine.setMessage('Read-side conversation from T3. Pushed live.')
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Pushed live.')

    engine.setOnline(false)
    await expect(page.getByTestId('conversation-disconnected')).toBeVisible({ timeout: 2_000 })
    await navigation.getByRole('tab', { name: 'Contents' }).click()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' Still here.')
    await expect(editor).toContainText('Still here.')
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).activeDocument?.content).toContain('Still here.')

    engine.setMessage('Conversation restored after reconnect.')
    engine.setOnline(true)
    await navigation.getByRole('tab', { name: 'Conversation' }).click()
    // The client may already have reconnected on its own by the time the tab shows; Reconnect is then gone.
    await page.getByRole('button', { name: 'Reconnect' }).dispatchEvent('click', undefined, { timeout: 2_000 }).catch(() => undefined)
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Conversation restored after reconnect.')
    expect(await page.evaluate(async () => (await window.strata.getState()).activeDocument?.content)).toContain('Still here.')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('2 conversation: moves between placements and dispatches a message, approval, user input, and Stop', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const side = page.getByRole('region', { name: 'Conversation' })
    await expect(side.locator('.conversation-message.assistant')).toContainText('Read-side conversation from T3.')
    await expect(side.getByRole('tablist', { name: 'Conversation scope' })).toHaveCount(0)
    await side.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    await expect(center).toBeVisible()
    await expect(center.getByRole('tablist', { name: 'Conversation scope' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Conversations menu' }).click()
    await expect(page.getByRole('menu', { name: 'Open conversations' }).getByRole('menuitem', { name: /^Live engine thread/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(center.locator('.conversation-message.assistant')).toContainText('Read-side conversation from T3.')

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
    await center.getByRole('button', { name: 'Answer', exact: true }).click()
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
    await expect(moved.getByRole('region', { name: 'comment thread' })).toBeVisible()
    await moved.getByRole('button', { name: 'Close thread', exact: true }).click()
    await expect(moved).toContainText('Read-side conversation from T3.')
  } finally {
    await scenario.dispose()
    await engine.close()
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
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('button', { name: 'Stop' }).click()
    const proseNode = conversation.locator('[data-message-id="m1"] [data-annotatable="true"]')
    await expect(proseNode).toHaveAttribute('data-block-ids', new RegExp(block.id))
    await expect(conversation.getByRole('region', { name: 'Turn items' }).getByText('Which approach should I take?')).toHaveCount(1)
    await expect(conversation).not.toContainText('```strata')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('4 inference: passage popups queue four keyed replies and preserve unanswered asks', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  const questions = ['Which audience should lead?', 'Should launch be public?', 'What is the budget?', 'Which region goes first?', 'Keep the old name?', 'Require approval?', 'When should work begin?']
  const source = questions.map((q,i) => `${i+1}. ${q}`).join('\n')
  const asks = await seedAsks(scenario, source, questions)
  try {
    engine.setMessage(source)
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const conversation = page.getByRole('region', { name: 'Conversation' })
    await conversation.getByRole('button', { name: 'Stop' }).click()
    await expect(conversation.locator('.conversation-ask-tag:visible')).toHaveCount(7)
    await expect(conversation.getByRole('region', { name: 'Turn items' })).toHaveCount(0)
    for (const [index, answer] of ['Audience', 'Yes', '$10k', 'West'].entries()) {
      await conversation.getByRole('button', { name: `Answer question: ${questions[index]}`, exact: true }).click()
      const popup = page.getByRole('dialog', { name: 'Your answer' })
      await popup.getByRole('textbox', { name: 'Your answer' }).fill(answer)
      await popup.getByRole('button', { name: 'Queue reply', exact: true }).click()
      await expect(popup).toHaveCount(0)
    }
    await expect(conversation.locator('.conversation-ask-tag[data-status="drafted"]:visible')).toHaveCount(4)
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find(command => command.type === 'thread.turn.start')!.message as { text: string; attachments: unknown[] }
    expect(turn.text).toBe('Replies to 4 items.')
    expect(turn.attachments).toHaveLength(1)
    await expect.poll(() => engine.uploads.length).toBe(1)
    const replies = JSON.parse(engine.uploads[0]!.match(/```json\n([\s\S]*?)\n```/)![1]!)
    expect(replies).toHaveLength(4)
    expect(replies[0]).toMatchObject({ itemId: asks[0]!.id, text: 'Audience' })
    engine.finish()
    await expect(conversation.locator('.conversation-ask-tag[data-status="done"]:visible')).toHaveCount(4)
    await conversation.getByRole('button', { name: '3 items from the agent', exact: true }).click()
    await conversation.getByRole('button', { name: `Dismiss question: ${questions[4]}`, exact: true }).click()
    await expect(conversation.locator('.conversation-ask-tag:visible')).toHaveCount(6)
    await page.reload()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await expect(page.locator('.conversation-ask-tag[data-status="done"]:visible')).toHaveCount(4)
    await expect(page.locator('.conversation-ask-tag[data-status="open"]:visible')).toHaveCount(2)
  } finally { await scenario.dispose(); await engine.close() }
})

test('8 and 9 projects: the blank draft is project-scoped, row actions dispatch, and turn files stay closed', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread in Cockpit project', exact: true }).click()
    const draft = page.getByRole('region', { name: 'New conversation' })
    await expect(draft.getByLabel('Conversation project')).toHaveAttribute('data-value', 'p1')
    await expect(draft.getByRole('button', { name: 'Choose model and account' })).toContainText('5.6')
    await expect(draft.getByRole('button', { name: 'Choose model and account' })).not.toContainText('GPT')
    await expect(draft.getByLabel('Message conversation')).toBeFocused()
    expect(engine.commands.some((command) => command.type === 'thread.create')).toBe(false)
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await expect(page.locator('.conversation-panel[data-placement="center"]')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).tabs.length)).toBe(1)
    await page.getByRole('button', { name: 'Settle Live engine thread' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.settle')).toBe(true)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('10 accounts: external usage is unavailable, parking from the top bar, and the model menu refuses parked accounts after reload', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Connected/)
    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Accounts', exact: true }).click()
    let modal = page.getByRole('dialog', { name: 'Accounts' })
    await expect(modal.getByTestId('account-state-codex')).toHaveText('Ready · not measured')
    await expect(modal.getByTestId('account-state-claude-main')).toHaveText('Ready · not measured')
    await expect(modal.locator('[data-instance="codex"]')).toContainText('owner@example.com')
    await expect(modal.locator('[data-instance="codex"]')).toContainText('Usage unavailable for this connection')
    await expect(modal.getByRole('meter')).toHaveCount(0)
    // Opening Accounts probes the engine for fresh usage (§5.13) before reading its configuration.
    await expect.poll(() => engine.rpcRequests.map((request) => request.tag)).toContain('server.refreshProviders')
    expect(engine.rpcRequests.map((request) => request.tag)).toContain('server.getConfig')
    const refreshCount = engine.rpcRequests.filter(request => request.tag === 'server.refreshProviders').length
    await modal.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => engine.rpcRequests.filter(request => request.tag === 'server.refreshProviders').length).toBeGreaterThan(refreshCount)
    await modal.getByRole('button', { name: 'Park Codex work' }).click()
    await expect(modal.getByTestId('account-state-codex')).toHaveText('Parked')
    await modal.getByRole('button', { name: 'Close' }).click()

    await page.reload()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Connected/)
    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Accounts', exact: true }).click()
    modal = page.getByRole('dialog', { name: 'Accounts' })
    await expect(modal.getByTestId('account-state-codex')).toHaveText('Parked')
    await expect(modal.getByRole('button', { name: 'Unpark Codex work' })).toBeVisible()
    await modal.getByRole('button', { name: 'Close' }).click()

    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread in Cockpit project', exact: true }).click()
    await page.getByRole('button', { name: 'Choose model and account' }).click()
    const models = page.getByRole('region', { name: 'Models and accounts' })
    await expect(models.getByRole('button', { name: 'GPT', exact: true })).toBeDisabled()
    await expect(models.getByRole('button', { name: 'Use Claude Fable 5.1', exact: true })).toBeEnabled()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('5.2 rows and notifications: pin, rename, and snooze go to T3, and thread attention does not add a Projects counter', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    const rows = page.locator('.project-thread')
    await expect(rows.first()).toHaveAttribute('data-thread', 't1')

    await page.getByRole('button', { name: 'Pin Second engine thread' }).click()
    await expect.poll(() => engine.commands.find((command) => command.type === 'thread.pin') ?? {}).toMatchObject({ threadId: 't2' })
    await expect(rows.first()).toHaveAttribute('data-thread', 't2')
    await expect(rows.first()).toHaveAttribute('data-pinned', 'true')

    await page.getByRole('button', { name: 'Open Second engine thread' }).dblclick()
    const rename = page.getByRole('textbox', { name: 'Rename Second engine thread' })
    await rename.fill('Renamed thread')
    await page.keyboard.press('Enter')
    await expect.poll(() => engine.commands.find((command) => command.type === 'thread.meta.update') ?? {}).toMatchObject({ threadId: 't2', title: 'Renamed thread' })
    await expect(page.getByRole('button', { name: 'Open Renamed thread' })).toBeVisible()

    await page.getByRole('button', { name: 'Open Renamed thread' }).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Actions for Renamed thread' }).getByRole('menuitem', { name: 'Tomorrow' }).click()
    await expect.poll(() => engine.commands.find((command) => command.type === 'thread.snooze') ?? {}).toMatchObject({ threadId: 't2', snoozedUntil: expect.stringMatching(/T\d\d:00:00/) })
    await expect(page.getByRole('button', { name: 'Snoozed' })).toContainText('1')
    await page.getByRole('button', { name: 'Snoozed' }).click()
    await page.locator('.project-shelf').filter({ hasText: 'Snoozed' }).getByRole('button', { name: 'Restore' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.unsnooze')).toBe(true)

    // The owner reads the renamed thread; the live thread finishes its turn elsewhere.
    await page.getByRole('button', { name: 'Open Renamed thread' }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible()
    await expect(navigation.getByRole('tab', { name: 'Projects' }).locator('.rail-tab-count')).toHaveCount(0)
    engine.finish()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.projects.flatMap(project => project.threads).find(thread => thread.id === 't1')?.attention).toBe(1)
    await expect(navigation.getByRole('tab', { name: 'Projects' }).locator('.rail-tab-count')).toHaveCount(0)
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.locator('.project-thread[data-thread="t1"]')).toBeVisible()
    // The approval is still open, so the finished turn keeps the Approval pill rather than the completed dot; never-visited threads never read as unread.
    await expect(page.locator('.project-thread[data-thread="t1"]')).toHaveAttribute('data-state', 'input')
    await expect(page.locator('.project-thread[data-thread="t2"]')).toHaveAttribute('data-state', 'idle')

    await page.getByRole('button', { name: 'Open Live engine thread' }).click()
    await expect(navigation.getByRole('tab', { name: 'Projects' }).locator('.rail-tab-count')).toHaveCount(0)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('cockpit parity: Conversation keeps prose visible and groups finished and live work like T3', async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'Open Live engine thread' }).click()
    const conversation = page.getByRole('region', { name: 'Conversation' })

    await expect(conversation).toContainText('First finished answer stays fully visible in the narrow placement.')
    await expect(conversation).toContainText('Second finished answer also stays visible.')
    // Each finished turn folds to one Worked for disclosure; its call groups appear only once the turn is open.
    await expect(conversation.locator('.conversation-turn-toggle')).toHaveCount(2)
    await expect(conversation.locator('.conversation-work-toggle')).toHaveCount(0)
    const finishedTurn = conversation.getByRole('button', { name: /^Worked for [\d.]+s/ }).first()
    await expect(finishedTurn).toHaveAttribute('aria-expanded', 'false')
    await finishedTurn.click()
    const commandWork = conversation.locator('.conversation-work-toggle').filter({ hasText: 'Ran 1 command' })
    await expect(commandWork).toHaveAttribute('aria-expanded', 'false')
    await commandWork.click()
    const finishedEntry = conversation.locator('.conversation-work-entry').filter({ hasText: 'Ran pnpm' })
    await expect(finishedEntry).toContainText('pnpm test')
    await expect(finishedEntry).toHaveAttribute('data-icon', 'terminal')
    await finishedEntry.getByRole('button').click()
    await expect(finishedEntry.locator('pre')).toContainText('pnpm test')
    await expect(conversation.locator('.conversation-working-row')).toContainText('Working')
    await expect(conversation.locator('.conversation-work-entry').filter({ hasText: 'Running electron-vite' })).toBeVisible()
    await expect(conversation.getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(conversation.getByText(/started/iu)).toHaveCount(0)

    await conversation.locator('.conversation-attachment-input').setInputFiles({ name: 'reference.md', mimeType: 'text/markdown', buffer: Buffer.from('# Reference\n') })
    await expect(conversation.locator('.conversation-attachment-preview')).toContainText('reference.md')
    await conversation.getByRole('button', { name: 'Remove reference.md' }).click()
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(0)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('cockpit parity: Projects renders folders, shelves, hover Settle, and the T3 action menu', async ({}, testInfo) => {
  const engine = await startEngine({ projectsParity: true, liveness: { t2: 'monitoring' } })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    const projects = page.locator('.projects-panel')
    await expect(projects.locator('.project-folder-header')).toHaveCount(2)
    await expect(projects.locator('.project-group').first().locator('.project-thread').first()).toHaveAttribute('data-thread', 't2')
    await expect(projects.getByRole('button', { name: 'Unpin Second engine thread' })).toHaveAttribute('aria-pressed', 'true')
    // 6.9 thread states: an open approval outranks the running session; T3's monitoring liveness draws the robot; the header rolls up the loudest state.
    const live = projects.locator('.project-thread[data-thread="t1"]')
    await expect(live).toHaveAttribute('data-state', 'input')
    await expect(live.locator('.project-thread-status')).toHaveText('Approval')
    const second = projects.locator('.project-thread[data-thread="t2"]')
    await expect(second).toHaveAttribute('data-state', 'monitoring')
    await expect(second.locator('.project-thread-status')).toContainText('Monitoring')
    await expect(projects.locator('.project-group').first().locator('.project-folder-state')).toHaveAttribute('data-state', 'input')
    await expect(second).not.toHaveClass(/active/)
    // Opening a thread moves the left window to Conversation after the double-click grace; come back to the rail.
    await projects.getByRole('button', { name: 'Open Second engine thread' }).click()
    await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'false')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await expect(second).toHaveClass(/active/)
    await expect(second).toHaveAttribute('data-state', 'monitoring')
    await expect(projects.getByRole('button', { name: 'Snoozed' })).toContainText('1')
    await expect(projects.getByRole('button', { name: 'Settled' })).toContainText('1')
    await expect(projects.locator('.project-group').filter({ hasText: 'Settled engine thread' })).toHaveCount(0)
    await expect(projects.locator('.project-group').filter({ hasText: 'Snoozed engine thread' })).toHaveCount(0)
    await expect(projects).not.toContainText('Rename Snooze Settle Archive Delete')

    const settle = projects.getByRole('button', { name: 'Settle Live engine thread' })
    await expect(settle).toHaveCSS('opacity', '0')
    await projects.locator('.project-thread[data-thread="t1"]').hover()
    await expect(settle).toHaveCSS('opacity', '1')

    await projects.getByRole('button', { name: 'Open Live engine thread' }).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Actions for Live engine thread' })
    await expect(menu.getByRole('menuitem').allTextContents()).resolves.toEqual(['Pin', 'Rename thread', 'An hour', 'Tomorrow', 'Next week', 'Settle', 'Mark unread', 'Copy Thread ID', 'Archive', 'Delete'])
    await page.keyboard.press('Escape')

    await projects.getByRole('button', { name: 'Open Second engine thread' }).dblclick()
    const rename = projects.getByRole('textbox', { name: 'Rename Second engine thread' })
    await rename.fill('Pinned and renamed')
    await page.keyboard.press('Enter')
    await expect.poll(() => engine.commands.find((command) => command.type === 'thread.meta.update') ?? {}).toMatchObject({ threadId: 't2', title: 'Pinned and renamed' })
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('Copy Thread ID puts the thread id on the system clipboard', { tag: '@clipboard' }, async ({}, testInfo) => {
  const engine = await startEngine({ projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ clipboard }) => clipboard.writeText('sentinel'))
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    const projects = page.locator('.projects-panel')
    await projects.getByRole('button', { name: 'Open Live engine thread' }).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Actions for Live engine thread' })
    await menu.getByRole('menuitem', { name: 'Copy Thread ID' }).click()
    await expect(menu).toBeHidden()
    await expect.poll(() => scenario.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('t1')
    await expect(page.getByRole('status')).toContainText('Thread ID copied.')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('conversation zoom: the side conversation follows the left window and the center conversation follows the editor, and messages render as blocks', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    engine.setMessage('## Plan\n\nRead the file, then patch it.\n\n```ts\nconst a = 1\n```\n\n- first\n- second')
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const side = page.getByRole('region', { name: 'Conversation' })
    const prose = side.locator('.conversation-message.assistant .conversation-prose')
    expect(await side.locator('.conversation-messages').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(100)
    // Block structure survives: a heading, a fenced code block, and a list, not one flattened run.
    await expect(prose.getByRole('heading', { name: 'Plan' })).toBeVisible()
    await expect(prose.locator('pre code')).toHaveText('const a = 1')
    await expect(prose.getByRole('listitem')).toHaveCount(2)
    const fontSize = (locator: typeof prose) => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    const zoomOf = (selector: string) => page.locator(selector).evaluate((element) => getComputedStyle(element).getPropertyValue('--zoom').trim())
    const hoverReading = async (panel: typeof side) => {
      const viewport = panel.locator('.conversation-messages')
      const height = await viewport.evaluate(element => element.clientHeight)
      await viewport.hover({ position: { x: 20, y: height - 8 } })
    }
    const sideBase = await fontSize(prose)
    expect(sideBase).toBeCloseTo(15, 0)

    // Changed files fold into a card (§6.9): count and delta, top-level folders, chips, and the list on request; never a wall of absolute paths.
    const card = side.getByRole('region', { name: 'Changed files' })
    await expect(card.getByRole('button', { name: /2 changed files/ })).toContainText('+12')
    await expect(card.locator('.conversation-files-folders')).toHaveText(/notes 1 file/)
    await expect(card.locator('.conversation-files-folders')).toHaveText(/src 1 file/)
    await expect(card.locator('.conversation-file-chip')).toHaveText(['mdone.md', 'tstwo.ts'])
    await expect(card).not.toContainText('/tmp/')
    await card.getByRole('button', { name: /Show files/ }).click()
    await expect(card.locator('.conversation-file-row')).toHaveCount(2)
    await expect(card.locator('.conversation-file-row').first()).toHaveAttribute('title', /\/notes\/one\.md$/)
    await expect(card.locator('.conversation-file-row').first()).toHaveText(/one\.md.*notes.*\+4/)
    await card.getByRole('button', { name: /Hide files/ }).click()
    await expect(card.locator('.conversation-file-row')).toHaveCount(0)

    // Ctrl+= over the side conversation scales the left window's factor, and the message text with it (§6.9).
    await hoverReading(side)
    await page.keyboard.press(primaryKey('Equal'))
    await expect.poll(() => zoomOf('[data-pane="explorer"]')).toBe('1.1')
    await expect.poll(() => fontSize(prose)).toBeCloseTo(16.5, 0)
    await openAppMenu(page)
    await expect(page.getByRole('menuitem', { name: 'Reset zoom' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Ctrl+wheel works the same way.
    await page.mouse.wheel(0, -120).catch(() => undefined)
    await hoverReading(side)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
    await expect.poll(() => zoomOf('[data-pane="explorer"]')).toBe('1.2')

    // In the center the conversation is the editor pane: the editor factor applies and the document's is untouched.
    await side.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    const centerProse = center.locator('.conversation-message.assistant .conversation-prose')
    await expect(centerProse.getByRole('heading', { name: 'Plan' })).toBeVisible()
    expect(await fontSize(centerProse)).toBeCloseTo(17, 0)
    await hoverReading(center)
    await page.keyboard.press(primaryKey('Equal'))
    await expect.poll(() => zoomOf('[data-pane="editor"]')).toBe('1.1')
    await expect.poll(() => fontSize(centerProse)).toBeCloseTo(18.7, 0)
    // Center conversations keep Projects on the left and history beside the transcript.
    await expect(navigation.getByRole('tab')).toHaveText(['Projects'])

    await openAppMenu(page)
    await page.getByRole('menuitem', { name: 'Reset zoom' }).click()
    await expect.poll(() => zoomOf('[data-pane="editor"]')).toBe('1')
    await expect.poll(() => fontSize(centerProse)).toBeCloseTo(17, 0)
    await center.getByRole('region', { name: 'Changed files' }).scrollIntoViewIfNeeded()
    await reviewCapture(page, { path: testInfo.outputPath('conversation-center.png') })
    await page.getByRole('button', { name: 'Move to side' }).click()
    await expect(side.locator('.conversation-message.assistant .conversation-prose').getByRole('heading', { name: 'Plan' })).toBeVisible()
    await side.getByRole('region', { name: 'Changed files' }).scrollIntoViewIfNeeded()
    await reviewCapture(page, { path: testInfo.outputPath('conversation-side.png') })
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
