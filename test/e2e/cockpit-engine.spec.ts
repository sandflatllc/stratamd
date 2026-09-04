import { expect, test } from '@playwright/test'
import { mapMarkdownBlocks } from '../../src/core/blocks'
import { readFile } from 'node:fs/promises'
import { credentialPath, seededScenario, startEngine } from './cockpit-engine-harness'

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

    await dialog.getByLabel('Pairing link').fill(`${engine.origin}/pair?token=second-code`)
    await dialog.getByRole('button', { name: 'Pair again' }).click()
    await expect.poll(() => engine.tokenRequests).toEqual(['first-code', 'second-code'])
    await expect.poll(async () => JSON.parse(await readFile(credentialPath(scenario), 'utf8')).accessToken).toBe('session-for-second-code')
    await dialog.getByRole('button', { name: 'Close' }).click()
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
    await page.waitForTimeout(250)

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
    await expect(side.getByRole('tab', { name: 'This passage' })).toBeDisabled()
    await side.getByRole('button', { name: 'Open in center' }).click()
    const center = page.locator('.conversation-panel[data-placement="center"]')
    await expect(center).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Live engine thread/ })).toBeVisible()
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

test('4 inference: seven prose questions queue four keyed replies in one delivery and leave three open', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    engine.setMessage('1. Which audience should lead?\n2. Should launch be public?\n3. What is the budget?\n4. Which region goes first?\n5. Keep the old name?\n6. Require approval?\n7. When should work begin?')
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
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
    await expect(checklist.getByText('Drafted: Audience')).toBeVisible()
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    // One delivery: the message text is one line, and the four replies travel keyed by item id in its attachment (§5.4).
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string; attachments: unknown[] }
    expect(turn.text).toBe('Replies to 4 items.')
    expect(turn.attachments).toHaveLength(1)
    await expect.poll(() => engine.uploads.length).toBe(1)
    expect(engine.uploads[0]!.match(/^inferred_[0-9a-f]+ ← user: /gmu)).toHaveLength(4)
    expect(engine.uploads[0]).toContain('← user: Audience')
    expect(engine.uploads[0]).toContain('about "Which audience should lead?"')
    engine.finish()
    await expect(checklist.locator('.turn-item[data-status="done"]')).toHaveCount(4)
    await expect(checklist.locator('.turn-item[data-status="open"]')).toHaveCount(3)
    // A dismissed inferred item stays dismissed for that message.
    await checklist.locator('.turn-item[data-status="open"]').first().getByRole('button', { name: 'Dismiss' }).click()
    await expect(checklist.locator('.turn-item[data-status="open"]')).toHaveCount(2)

    // Reload: the answers, the open items, and the dismissal are main-process state, not the panel's.
    await page.reload()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const reopened = page.getByRole('region', { name: 'Conversation' }).getByRole('region', { name: 'Turn items' })
    await expect(reopened.locator('.turn-item')).toHaveCount(6)
    await expect(reopened.locator('.turn-item[data-status="done"]')).toHaveCount(4)
    await expect(reopened.locator('.turn-item[data-status="open"]')).toHaveCount(2)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('8 and 9 projects: the blank draft is project-scoped, row actions dispatch, and turn files stay closed', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    const draft = page.getByRole('region', { name: 'New conversation' })
    await expect(draft.getByLabel('Conversation project')).toHaveValue('p1')
    await expect(draft.getByRole('button', { name: 'Choose model and account' })).toContainText('GPT-5.6')
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

test('10 accounts: usage from the engine, parking from the top bar, and the model menu refuses parked accounts after reload', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Connected/)
    await page.getByRole('button', { name: 'Accounts', exact: true }).click()
    let modal = page.getByRole('dialog', { name: 'Accounts' })
    await expect(modal.getByTestId('account-state-codex')).toHaveText('Ready · 40% used')
    await expect(modal.getByTestId('account-state-claude-main')).toHaveText('Ready · not measured')
    await expect(modal.locator('[data-instance="codex"]')).toContainText('owner@example.com')
    await expect(modal.locator('[data-instance="codex"] .account-usage[data-window="session"] small')).toContainText('40%')
    // Opening Accounts probes the engine for fresh usage (§5.13) before reading its configuration.
    await expect.poll(() => engine.rpcRequests.map((request) => request.tag)).toContain('server.refreshProviders')
    expect(engine.rpcRequests.map((request) => request.tag)).toContain('server.getConfig')
    await modal.getByRole('button', { name: 'Park Codex work' }).click()
    await expect(modal.getByTestId('account-state-codex')).toHaveText('Parked')
    await modal.getByRole('button', { name: 'Close' }).click()

    await page.reload()
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Connected/)
    await page.getByRole('button', { name: 'Accounts', exact: true }).click()
    modal = page.getByRole('dialog', { name: 'Accounts' })
    await expect(modal.getByTestId('account-state-codex')).toHaveText('Parked')
    await expect(modal.getByRole('button', { name: 'Unpark Codex work' })).toBeVisible()
    await modal.getByRole('button', { name: 'Close' }).click()

    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await page.getByRole('button', { name: 'Choose model and account' }).click()
    const models = page.getByRole('region', { name: 'Models and accounts' })
    await expect(models.getByRole('button', { name: /^GPT-5.6 Codex work/ })).toBeDisabled()
    await expect(models.getByRole('button', { name: 'Claude Fable 5.1 Claude', exact: true })).toBeEnabled()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('5.2 rows and notifications: pin, rename, and snooze go to T3, and a turn finishing elsewhere badges Projects and the thread until it opens', async ({}, testInfo) => {
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
    await expect(navigation.getByRole('tab', { name: 'Projects' }).locator('.rail-tab-count')).toHaveText('1')
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.locator('.project-thread[data-thread="t1"]')).toBeVisible()

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
    await expect(conversation.locator('.conversation-work-toggle')).toHaveCount(2)
    const commandWork = conversation.getByRole('button', { name: 'Ran 1 command' })
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
  const engine = await startEngine({ projectsParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    const projects = page.locator('.projects-panel')
    await expect(projects.locator('.project-folder-header')).toHaveCount(2)
    await expect(projects.locator('.project-group').first().locator('.project-thread').first()).toHaveAttribute('data-thread', 't2')
    await expect(projects.getByRole('button', { name: 'Unpin Second engine thread' })).toHaveAttribute('aria-pressed', 'true')
    await expect(projects.locator('.project-thread[data-thread="t1"]')).toContainText('Working')
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
