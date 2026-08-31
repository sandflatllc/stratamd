import { expect, test, type TestInfo } from '@playwright/test'
import { mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  Scenario,
  allHunks,
  copyForAgent,
  expectPayload,
  externalText,
  projectRoot,
  save,
  selectTextInVisualEditor,
  selectVisualEditorRange,
  send,
  setSource,
  spawnCli
} from './harness'

const liveScenarios = new Set<Scenario>()

async function scenario(testInfo: TestInfo, content: string | Buffer = '# Scenario\n\nOriginal paragraph.\n', name?: string): Promise<Scenario> {
  const value = name ? await Scenario.create(testInfo, content, name) : await Scenario.create(testInfo, content)
  liveScenarios.add(value)
  return value
}

test.afterEach(async () => {
  await Promise.all([...liveScenarios].map(async (value) => {
    await value.dispose()
    liveScenarios.delete(value)
  }))
})

async function waitForReviewAction(value: Scenario, action: 'Keep' | 'Revert' | 'Accept'): Promise<void> {
  await expect(value.page!.getByRole('button', { name: new RegExp(`^${action}(?:\\b|$)`, 'i') }).first()).toBeVisible()
}

async function agentWritesBuffer(value: Scenario, agent: string, next: string): Promise<void> {
  await value.tag(agent)
  const state = await value.state()
  expect(state.buffer).toBeTruthy()
  await value.atomicWrite(state.buffer!, next)
  await value.waitForBuffer(next)
}

async function closeTab(value: Scenario, choice?: 'Save' | 'Discard'): Promise<void> {
  const page = value.page!
  await page.getByRole('button', { name: /Close tab/i }).click()
  if (!choice) return
  const dialog = page.getByRole('dialog', { name: /Close .*\.md/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: new RegExp(`^${choice}$`, 'i') }).click()
  await expect(dialog).toBeHidden()
}

test.describe('PRD §6.12 acceptance scenarios', () => {
  test('1. a late recipient gets frozen deliveries in Send order', async ({}, testInfo) => {
    const value = await scenario(testInfo)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')

    const first = '# Scenario\n\nFirst user round.\n'
    await setSource(value.page!, first)
    await value.waitForBuffer(first)
    await send(value.page!, { note: 'first note' })

    const second = '# Scenario\n\nFirst user round.\n\nSecond user round.\n'
    await setSource(value.page!, second)
    await value.waitForBuffer(second)
    await send(value.page!, { note: 'second note' })

    const firstDelivery = await value.attach('agent-a')
    expect(firstDelivery.event).toBe('send')
    expect(firstDelivery.notes).toEqual(['first note'])
    expect(firstDelivery.text).toContain('First user round.')
    expect(firstDelivery.text).not.toContain('Second user round.')

    const secondDelivery = await value.attach('agent-a')
    expect(secondDelivery.event).toBe('send')
    expect(secondDelivery.deliveryId).not.toBe(firstDelivery.deliveryId)
    expect(secondDelivery.notes).toEqual(['second note'])
    expect(secondDelivery.text).toContain('Second user round.')
  })

  test('2. killing the CLI during stdout flush redelivers the same delivery id', async ({}, testInfo) => {
    const value = await scenario(testInfo)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')

    const largeRound = `# Large delivery\n\n${'user payload '.repeat(30_000)}\n`
    await setSource(value.page!, largeRound)
    await value.waitForBuffer(largeRound)
    await send(value.page!)

    const child = spawnCli(['attach', value.file, '--as', 'agent-a', '--timeout', '0'], value.env)
    let prefix = ''
    const interruptedId = await new Promise<string>((resolveId, rejectId) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectId(new Error('The CLI did not begin writing the queued delivery'))
      }, 15_000)
      child.stdout.setEncoding('utf8')
      child.stdout.once('data', (chunk: string) => {
        clearTimeout(timer)
        prefix += chunk
        const match = prefix.match(/"deliveryId"\s*:\s*"([^"]+)"/)
        child.stdout.destroy()
        child.kill('SIGKILL')
        if (!match) rejectId(new Error(`deliveryId was not in the first stdout chunk: ${prefix.slice(0, 300)}`))
        else resolveId(match[1]!)
      })
      child.once('error', rejectId)
    })

    const retried = await value.attach('agent-a')
    expect(retried.event).toBe('send')
    expect(retried.deliveryId).toBe(interruptedId)
  })

  test('3. a mixed proposal confirms Revert and Keep preserves the user edit', async ({}, testInfo) => {
    const original = '# Plan\n\nShip the importer Friday.\n'
    const proposed = '# Plan\n\nShip the importer Thursday.\n'
    const mixed = '# Plan\n\nShip the reliable importer Thursday.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')
    await agentWritesBuffer(value, 'agent-a', proposed)
    await waitForReviewAction(value, 'Revert')

    await setSource(value.page!, mixed)
    await value.waitForBuffer(mixed)
    await value.page!.getByRole('button', { name: /^Revert(?:\b|$)/i }).first().click()

    const dialog = value.page!.getByRole('dialog', { name: /Revert this change/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/discards? your edits inside/i)
    await dialog.getByRole('button', { name: /^Cancel$/i }).click()

    await value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i }).first().click()
    await expect.poll(async () => (await value.state()).document).toBe(mixed)
    expect(await readFile((await value.state()).buffer!, 'utf8')).toBe(mixed)
  })

  test('4. Save writes the shadow but leaves overlapped agent work pending', async ({}, testInfo) => {
    const original = '# Plan\n\nShip Friday.\n\nOwner note.\n'
    const proposed = '# Plan\n\nShip Thursday.\n\nOwner note.\n'
    const mixed = '# Plan\n\nShip Thursday after review.\n\nUpdated owner note.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')
    await agentWritesBuffer(value, 'agent-a', proposed)
    await waitForReviewAction(value, 'Keep')

    await setSource(value.page!, mixed)
    await value.waitForBuffer(mixed)
    await save(value.page!)

    expect(await readFile(value.file, 'utf8')).toBe(mixed)
    await waitForReviewAction(value, 'Keep')
    const changes = await value.changes()
    expect(externalText(changes)).toContain('Ship Thursday')
  })

  test('5. Save rechecks disk and stops for a racing external write', async ({}, testInfo) => {
    const original = '# Race\n\nOriginal block.\n'
    const mine = '# Race\n\nMy unsaved block.\n'
    const incoming = '# Race\n\nIncoming disk block.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    await setSource(value.page!, mine)
    await value.waitForBuffer(mine)

    await value.atomicWrite(value.file, incoming)
    // The watcher raises the same conflict on its own within ~100 ms, and the
    // conflict modal's backdrop covers the Save button. Drive Save from the
    // keyboard so this holds whichever side wins the race.
    await value.page!.keyboard.press('Control+s')

    const dialog = value.page!.getByRole('dialog', { name: /External write conflicts with your edits/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/changed (?:on disk )?while/i)
    expect(await readFile(value.file, 'utf8')).toBe(incoming)
    // Save was refused, not deferred: the unsaved edit is still only in the buffer.
    expect(await readFile((await value.state()).buffer!, 'utf8')).toBe(mine)
  })

  test('6. crash recovery offers Recover without replacing the newer buffer', async ({}, testInfo) => {
    const original = '# Recovery\n\nSaved text.\n'
    const unsaved = '# Recovery\n\nUnsaved text survives.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    await setSource(value.page!, unsaved)
    await value.waitForBuffer(unsaved)
    const buffer = (await value.state()).buffer!
    await value.stop(true)

    await value.launch()
    const dialog = value.page!.getByRole('dialog', { name: /Recover unsaved edits/i })
    await expect(dialog).toBeVisible()
    expect(await readFile(value.file, 'utf8')).toBe(original)
    expect(await readFile(buffer, 'utf8')).toBe(unsaved)
    await dialog.getByRole('button', { name: /Recover my edits/i }).click()
    await expect.poll(async () => (await value.state()).document).toBe(unsaved)
  })

  test('6b. undo walks later typing, the external merge, and earlier typing in order', async ({}, testInfo) => {
    const original = '# Undo\n\nBase.\n'
    const ownerEdit = '# Undo\n\nBase. Owner\n'
    const externalEdit = '# Undo\n\nBase. Owner Agent.\n'
    const laterEdit = '# Undo\n\nBase. Owner Agent. Later\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')

    const editor = value.page!.getByRole('textbox', { name: /document editor/i })
    await editor.locator('p').filter({ hasText: 'Base.' }).click({ position: { x: 4, y: 8 } })
    await value.page!.keyboard.press('End')
    await value.page!.keyboard.type(' Owner')
    await value.waitForBuffer(ownerEdit)

    await agentWritesBuffer(value, 'agent-a', externalEdit)
    await waitForReviewAction(value, 'Keep')
    await editor.locator('p').filter({ hasText: 'Base.' }).click({ position: { x: 4, y: 8 } })
    await value.page!.keyboard.press('End')
    await value.page!.keyboard.type(' Later')
    await value.waitForBuffer(laterEdit)

    await editor.focus()
    await value.page!.keyboard.press('Control+z')
    await value.waitForBuffer(externalEdit)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(1)

    await editor.focus()
    await value.page!.keyboard.press('Control+z')
    await expect.poll(async () => (await value.state()).document).toBe(ownerEdit)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)
    // The reversal reaches the agent as a user hunk on the next Send.
    await send(value.page!)
    const delivered = await value.attach('agent-a')
    expect(allHunks(delivered).some((hunk) => hunk.removed.join('\n').includes('Agent.'))).toBe(true)

    // Send ends the application history; typing history continues across it.
    await editor.focus()
    await value.page!.keyboard.press('Control+z')
    await value.waitForBuffer(original)
  })

  test('7. Discard on close removes buffer-only pending hunks on reopen', async ({}, testInfo) => {
    const original = '# Close\n\nDisk text.\n'
    const proposed = '# Close\n\nAgent-only buffer text.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')
    await agentWritesBuffer(value, 'agent-a', proposed)
    await waitForReviewAction(value, 'Keep')

    await closeTab(value, 'Discard')
    expect((await value.cli(['open', value.file])).code).toBe(0)
    await expect(value.page!.getByText(basename(value.file), { exact: false }).first()).toBeVisible()
    expect(await readFile((await value.state()).buffer!, 'utf8')).toBe(original)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)
    expect(allHunks(await value.changes())).toHaveLength(0)
  })

  test('8. renaming an open file moves its one session and ghost entry', async ({}, testInfo) => {
    const value = await scenario(testInfo, '# Rename\n\nFollow me.\n')
    await value.writeSettings({ explorerFolders: [dirname(value.file)] })
    await value.launch()
    await value.state()
    const docsRoot = join(String(value.env.XDG_DATA_HOME), 'stratamd/docs')
    const beforeEntries = await readdir(docsRoot)
    expect(beforeEntries).toHaveLength(1)

    const movedDirectory = join(dirname(value.file), 'moved')
    await mkdir(movedDirectory)
    const renamed = join(movedDirectory, 'renamed.md')
    await rename(value.file, renamed)
    await expect.poll(async () => (await value.cli(['state', renamed])).code).toBe(0)
    const moved = expectPayload(await value.cli(['state', renamed]))
    expect(moved.file).toBe(await realpath(renamed))
    expect(await readdir(docsRoot)).toEqual(beforeEntries)
    expect((await value.cli(['state', value.file])).code).toBe(2)
  })

  test('9. a mismatched suggestion becomes orphaned and cannot be accepted', async ({}, testInfo) => {
    const original = '# Suggestion\n\nThe exact quoted sentence.\n'
    const changed = '# Suggestion\n\nThe user replaced that sentence.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')
    const created = await value.cli([
      'annotate', value.file,
      '--kind', 'suggestion',
      '--quote', 'The exact quoted sentence.',
      '--text', 'A proposed replacement.',
      '--as', 'agent-a'
    ])
    expect(created.code, created.stderr).toBe(0)
    await expect.poll(async () => (await value.state()).annotations?.some((item) => item.kind === 'suggestion')).toBe(true)

    await setSource(value.page!, changed)
    await value.waitForBuffer(changed)
    await save(value.page!)
    await closeTab(value)
    expect((await value.cli(['open', value.file])).code).toBe(0)

    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.kind === 'suggestion')?.status).toBe('orphaned')
    await expect(value.page!.getByRole('button', { name: /^Accept(?:\b|$)/i })).toHaveCount(0)
  })

  test('9b. visual cross-block comments retain exact markdown separators and reject suggestions', async ({}, testInfo) => {
    const original = '# Annotation\n\nAlpha tail.\n\nBeta head.\n'
    const value = await scenario(testInfo, original)
    await value.launch()

    await selectVisualEditorRange(value.page!, 'tail.', 'Beta')
    const menu = value.page!.getByRole('menu', { name: /Annotate selection/i })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Suggest/i })).toBeDisabled()
    await menu.getByRole('menuitem', { name: /Comment/i }).click()
    await value.page!.getByRole('textbox', { name: /Annotation text/i }).fill('Cross-block note')
    await value.page!.getByRole('button', { name: /^Add$/i }).click()

    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.text === 'Cross-block note')?.quote)
      .toBe('tail.\n\nBeta')
  })

  test('10. real corpus files no-op byte round-trip and strong edits stay local', async ({}, testInfo) => {
    const cases = [
      ['launch-queue-index.md', 'navigation index'],
      ['customer-document-bridge.md', 'production-capable rendering bridge'],
      ['security-stability-plan.md', 'Bug-fix-class maintenance slice']
    ] as const

    for (const [name, target] of cases) {
      const sourcePath = join(projectRoot, 'test/corpus/real', name)
      const sourceBytes = await readFile(sourcePath)
      const value = await scenario(testInfo, sourceBytes, name)
      await value.launch()

      await save(value.page!)
      expect(await readFile(value.file)).toEqual(sourceBytes)

      await selectTextInVisualEditor(value.page!, target)
      await value.page!.getByRole('button', { name: /^Bold$/i }).click()
      await expect(value.page!.getByRole('textbox', { name: /document editor/i }).locator('strong').filter({ hasText: target })).toBeVisible()
      await save(value.page!)
      const expected = sourceBytes.toString('utf8').replace(target, `**${target}**`)
      expect(await readFile(value.file, 'utf8')).toBe(expected)
      await value.stop()
    }
  })

  test('11. StrataMD mirror and Save writes do not create external review hunks', async ({}, testInfo) => {
    const edited = '# Own writes\n\nA user edit.\n'
    const value = await scenario(testInfo, '# Own writes\n\nOriginal.\n')
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')
    await setSource(value.page!, edited)
    await value.waitForBuffer(edited)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)

    await save(value.page!)
    expect(await readFile(value.file, 'utf8')).toBe(edited)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)
    expect((await value.changes()).segments ?? []).toHaveLength(0)
  })

  test('12. an unacknowledged delivery survives timeout, close, restart, and idle expiry', async ({}, testInfo) => {
    const value = await scenario(testInfo, '# Durable queue\n\nOriginal.\n')
    // Keep the empty attachment alive while the two CLI processes start. The
    // short expiry belongs after the delivery is queued: an attachment with no
    // unacknowledged work is allowed to expire normally.
    await value.writeSettings({ attachmentIdleTimeoutMs: 60_000 })
    await value.launch()
    expect((await value.attach('agent-a')).event).toBe('initial')
    expect((await value.attach('agent-a')).event).toBe('timeout')

    const edited = `# Durable queue\n\nQueued user edit.\n\n${'durable payload '.repeat(20_000)}\n`
    await setSource(value.page!, edited)
    await value.waitForBuffer(edited)
    await save(value.page!)
    await send(value.page!)

    const child = spawnCli(['attach', value.file, '--as', 'agent-a', '--timeout', '0'], value.env)
    const interruptedId = await new Promise<string>((resolveId, rejectId) => {
      const timer = setTimeout(() => rejectId(new Error('No delivery arrived')), 15_000)
      child.stdout.setEncoding('utf8')
      child.stdout.once('data', (chunk: string) => {
        clearTimeout(timer)
        const match = chunk.match(/"deliveryId"\s*:\s*"([^"]+)"/)
        child.stdout.destroy()
        child.kill('SIGKILL')
        match ? resolveId(match[1]!) : rejectId(new Error('deliveryId was absent before interruption'))
      })
    })

    await value.page!.evaluate(() => window.strata.updateSettings({ attachmentIdleHours: 100 / (60 * 60 * 1_000) }))

    await closeTab(value)
    await value.stop()
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    await value.launch()
    const retried = await value.attach('agent-a')
    expect(retried.deliveryId).toBe(interruptedId)
    expect(retried.text).toContain('Queued user edit.')
  })

  test('13. Save does not advance the Copy for agent baseline', async ({}, testInfo) => {
    const value = await scenario(testInfo, '# Clipboard\n\nOriginal.\n')
    await value.launch()
    await copyForAgent(value.page!)
    const initialClipboard = await value.app!.evaluate(({ clipboard }) => clipboard.readText())
    expect(initialClipboard).toContain('Original.')

    const edited = '# Clipboard\n\nSaved since the prior copy.\n'
    await setSource(value.page!, edited)
    await value.waitForBuffer(edited)
    await save(value.page!)
    await copyForAgent(value.page!)

    const secondClipboard = await value.app!.evaluate(({ clipboard }) => clipboard.readText())
    expect(secondClipboard).toContain('Saved since the prior copy.')
    expect(secondClipboard).not.toBe(initialClipboard)
  })

  test('14. one agent sees another agent edit only through changes or explicit inclusion', async ({}, testInfo) => {
    const original = '# Isolation\n\nShared paragraph.\n\nOwner line.\n'
    const external = '# Isolation\n\nAgent B private edit.\n\nOwner line.\n'
    const withUserEdit = '# Isolation\n\nAgent B private edit.\n\nOwner line updated.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')
    expect((await value.attach('agent-c', 'Agent C')).event).toBe('initial')
    await agentWritesBuffer(value, 'agent-b', external)

    expect((await value.attach('agent-a')).event).toBe('timeout')
    const explicitChanges = await value.changes()
    expect(externalText(explicitChanges)).toContain('Agent B private edit.')

    await setSource(value.page!, withUserEdit)
    await value.waitForBuffer(withUserEdit)
    await send(value.page!, { recipientNames: ['Agent A'] })
    const excluded = await value.attach('agent-a')
    expect(excluded.text).toContain('Owner line updated.')
    expect(excluded.segments?.every((segment) => segment.author === 'user')).toBe(true)

    const finalRound = `${withUserEdit}\nAnother owner line.\n`
    await setSource(value.page!, finalRound)
    await value.waitForBuffer(finalRound)
    await send(value.page!, { includeExternal: true, recipientNames: ['Agent C'] })
    const included = await value.attach('agent-c')
    expect(included.segments?.some((segment) => segment.author === 'external')).toBe(true)
    expect(included.text).toContain('Agent B private edit.')
  })

  test('15. Accept changes only the buffer, notifies its author, and reaches peers as user work', async ({}, testInfo) => {
    const original = '# Accept\n\nUse the original phrase here.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    const created = await value.cli([
      'annotate', value.file,
      '--kind', 'suggestion',
      '--quote', 'the original phrase',
      '--text', 'the accepted phrase',
      '--as', 'agent-a'
    ])
    expect(created.code, created.stderr).toBe(0)
    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.kind === 'suggestion')).not.toBeUndefined()
    const suggestion = (await value.state()).annotations?.find((item) => item.kind === 'suggestion')
    expect(suggestion).toBeTruthy()
    await waitForReviewAction(value, 'Accept')
    await value.page!.getByRole('button', { name: /^Accept(?:\b|$)/i }).first().click()

    const accepted = '# Accept\n\nUse the accepted phrase here.\n'
    await value.waitForBuffer(accepted)
    expect(await readFile(value.file, 'utf8')).toBe(original)
    await send(value.page!)

    const authorDelivery = await value.attach('agent-a')
    expect(authorDelivery.resolved).toContainEqual(expect.objectContaining({ id: suggestion!.id, resolution: 'accepted' }))
    const peerDelivery = await value.attach('agent-b')
    expect(peerDelivery.segments?.some((segment) => segment.author === 'user')).toBe(true)
    expect(peerDelivery.text).toContain('the accepted phrase')
    expect(await readFile(value.file, 'utf8')).toBe(original)
  })
})
