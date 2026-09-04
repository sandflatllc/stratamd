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
    await expect(dialog.getByTestId('engine-version')).toHaveText('0.0.33')
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
    await page.getByRole('button', { name: 'Reconnect' }).dispatchEvent('click')
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
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const text = ((engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string }).text)
    expect(text.match(/^- inferred_[^:]+:/gmu)).toHaveLength(4)
    engine.finish()
    await expect(checklist.locator('.turn-item[data-status="open"]')).toHaveCount(3)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('8 and 9 projects: picker is project-scoped, row actions dispatch, and turn files stay closed in Documents', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'New thread' }).click()
    const picker = page.getByRole('form', { name: 'Start thread' })
    await expect(picker.getByLabel('Project')).toHaveValue('p1')
    await expect(picker.getByLabel('Model')).toHaveValue('gpt-5.6')
    await expect(picker.getByLabel('Account')).toHaveValue('auto')
    await picker.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible()
    await expect(page.locator('.documents-panel > button')).toHaveCount(2)
    await expect(page.locator('.tabs > .tab:not(.conversation-tab)')).toHaveCount(1)
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'Settle Live engine thread' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.settle')).toBe(true)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('10 accounts: modal and picker show the same provider instance and parking state', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'Accounts' }).click()
    const modal = page.getByRole('dialog', { name: 'Accounts' })
    await expect(modal).toContainText('codex')
    await expect(modal).toContainText('Ready · not measured')
    await modal.getByRole('button', { name: 'Park' }).dispatchEvent('click')
    await expect(modal).toContainText('Parked')
    await modal.getByRole('button', { name: 'Close' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'New thread' }).click()
    await expect(page.getByLabel('Account').getByRole('option', { name: /codex · parked/ })).toHaveAttribute('disabled', '')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
