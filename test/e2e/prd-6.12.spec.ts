import { openDocsMenu } from './harness'
import { expect, test, type TestInfo } from './test'
import { mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  Scenario,
  allHunks,
  externalText,
  lineEndKey,
  primaryKey,
  projectRoot,
  save,
  selectTextInVisualEditor,
  selectVisualEditorRange,
  send,
  setSource,
} from './harness'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { agentActs, annotationByText, attachThread, openThread, uploadsFor } from './cockpit-agent'

// PRD §6.12 acceptance scenarios on the cockpit: agents are T3 threads
// attached to the document, their edits and suggestions arrive as strata
// blocks (§5.9), and a delivery is a turn whose upload the fake engine keeps.
// Scenario 2 (killing the agent CLI mid-flush) and 13 (the Copy for agent
// baseline) are gone with the CLI and Copy for agent (cockpit plan §11 phase 5).

const liveScenarios = new Set<Scenario>()
const liveEngines = new Set<FakeEngine>()

async function scenario(testInfo: TestInfo, content: string | Buffer = '# Scenario\n\nOriginal paragraph.\n', name?: string): Promise<Scenario> {
  const value = name ? await Scenario.create(testInfo, content, name) : await Scenario.create(testInfo, content)
  liveScenarios.add(value)
  return value
}

/** A scenario paired with a fake engine whose threads are named like agents. */
async function engineScenario(testInfo: TestInfo, content: string = '# Scenario\n\nOriginal paragraph.\n', name = 'scenario.md'): Promise<{ value: Scenario; engine: FakeEngine }> {
  const engine = await startEngine({ titles: { t1: 'Agent A', t2: 'Agent B' } })
  liveEngines.add(engine)
  const value = await seededScenario(testInfo, engine.origin, content, name)
  liveScenarios.add(value)
  return { value, engine }
}

/** Attaches each thread by sending the document to it, and leaves the first one as the active conversation. */
async function attachAll(value: Scenario, engine: FakeEngine, threads: Array<['t1' | 't2', string]>): Promise<void> {
  const page = value.page!
  for (const [id, title] of threads) {
    await openThread(page, title)
    await attachThread(page, engine, id, title)
  }
  await openThread(page, threads[0]![1])
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
}

test.afterEach(async () => {
  await Promise.all([...liveScenarios].map(async (value) => {
    await value.dispose()
    liveScenarios.delete(value)
  }))
  await Promise.all([...liveEngines].map(async (engine) => {
    await engine.close()
    liveEngines.delete(engine)
  }))
})

async function waitForReviewAction(value: Scenario, action: 'Keep' | 'Revert' | 'Accept'): Promise<void> {
  await expect(value.page!.getByRole('button', { name: new RegExp(`^${action}(?:\\b|$)`, 'i') }).first()).toBeVisible()
}

/** The agent replaces `match` inside the passage `quote` with `replace`, and the hunk shows for review. */
async function agentEdits(value: Scenario, engine: FakeEngine, threadId: string, quote: string, match: string, replace: string): Promise<void> {
  agentActs(engine, threadId, [{ verb: 'edit', anchor: { document: value.file, quote }, match, replace }])
  await waitForReviewAction(value, 'Keep')
}

async function closeTab(value: Scenario, choice?: 'Save' | 'Discard'): Promise<void> {
  const page = value.page!
  const path = (await page.evaluate(() => window.strata.getState())).activeDocument!.path
  await openDocsMenu(page)
  await page.getByRole('menu', { name: 'Open docs' }).getByRole('button', { name: `Close ${path.split('/').at(-1)}`, exact: true }).click()
  if (!choice) return
  const dialog = page.getByRole('dialog', { name: /Close .*\.md/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: new RegExp(`^${choice}$`, 'i') }).click()
  await expect(dialog).toBeHidden()
}

async function reopen(value: Scenario): Promise<void> {
  await value.page!.evaluate((path) => window.strata.openDocument(path), value.file)
  await expect.poll(async () => (await value.page!.evaluate(() => window.strata.getState())).activeDocument?.path).toBe(value.file)
}

test.describe('PRD §6.12 acceptance scenarios', () => {
  test('1. deliveries queued while the engine is down reach the thread in Send order', async ({}, testInfo) => {
    const { value, engine } = await engineScenario(testInfo)
    await value.launch()
    await value.app!.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const original = handlers.get('strata:preview-send')!
      const previews: unknown[] = []
      Object.assign(globalThis, { __offlinePreviews: previews })
      handlers.set('strata:preview-send', async (...args) => {
        const entry = { started: Date.now(), ended: 0, request: args[2] }
        previews.push(entry)
        try { return await original(...args) } finally { entry.ended = Date.now() }
      })
    })
    // Preserve actual click targets if this rare Send-dialog failure recurs under load.
    await value.page!.evaluate(() => {
      const clicks: unknown[] = []
      Object.assign(window, { __offlineSendClicks: clicks })
      document.addEventListener('click', event => {
        const target = event.target as HTMLElement
        const dialog = document.querySelector('.send-composer')
        clicks.push({ at: performance.now(), target: target.tagName, class: target.className,
          text: target.textContent?.slice(0, 100), note: dialog?.querySelector('textarea')?.value,
          pending: dialog?.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy') })
      }, true)
    })
    let completed = false
    try {
      await attachAll(value, engine, [['t1', 'Agent A']])
      engine.setOnline(false)
      await expect(value.page!.getByRole('button', { name: 'Engine status' })).toHaveText(/Disconnected/)

      const first = '# Scenario\n\nFirst user round.\n'
      await setSource(value.page!, first)
      await value.waitForBuffer(first)
      await send(value.page!, { note: 'first note' })

      const second = '# Scenario\n\nFirst user round.\n\nSecond user round.\n'
      await setSource(value.page!, second)
      await value.waitForBuffer(second)
      await send(value.page!, { note: 'second note' })
      await expect.poll(async () => value.page!.evaluate(async () => (await window.strata.getState()).activeDocument?.attachments[0]?.queuedSendCount)).toBe(2)

      engine.setOnline(true)
      await expect.poll(() => uploadsFor(engine, 't1').length, { timeout: 15_000 }).toBe(3)
      const [, firstDelivery, secondDelivery] = uploadsFor(engine, 't1')
      expect(firstDelivery).toContain('- first note')
      expect(firstDelivery).toContain('First user round.')
      expect(firstDelivery).not.toContain('Second user round.')
      expect(secondDelivery).toContain('- second note')
      expect(secondDelivery).toContain('Second user round.')
      const turns = engine.commands.filter((command) => command.type === 'thread.turn.start')
      expect(new Set(turns.map((turn) => (turn.message as { messageId: string }).messageId)).size).toBe(3)
      completed = true
    } finally {
      if (!completed) {
        await testInfo.attach('offline-preview-requests', { body: JSON.stringify(await value.app!.evaluate(() => (globalThis as unknown as { __offlinePreviews: unknown[] }).__offlinePreviews)), contentType: 'application/json' })
        await testInfo.attach('offline-send-state', { body: JSON.stringify(await value.page!.evaluate(async () => ({
          clicks: (window as unknown as { __offlineSendClicks: unknown[] }).__offlineSendClicks,
          document: (await window.strata.getState()).activeDocument
        }))), contentType: 'application/json' })
        await value.page!.screenshot({ path: testInfo.outputPath('offline-send.png') })
      }
    }
  })

  test('3. a mixed proposal confirms Revert and Keep preserves the user edit', async ({}, testInfo) => {
    const original = '# Plan\n\nShip the importer Friday.\n'
    const mixed = '# Plan\n\nShip the reliable importer Thursday.\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A']])
    await agentEdits(value, engine, 't1', 'Ship the importer Friday.', 'Friday', 'Thursday')
    await waitForReviewAction(value, 'Revert')

    await setSource(value.page!, mixed)
    await value.waitForBuffer(mixed)
    await value.page!.getByRole('button', { name: /^Revert(?:\b|$)/i }).first().click()

    const dialog = value.page!.getByRole('dialog', { name: /Revert this change/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/discards? your edits inside/i)
    await dialog.getByRole('button', { name: /^Cancel$/i }).click()

    await value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i }).first().click()
    await expect.poll(async () => (await value.inspectDocument()).document).toBe(mixed)
    expect(await readFile((await value.inspectDocument()).buffer!, 'utf8')).toBe(mixed)
  })

  test('4. Save writes the shadow but leaves overlapped agent work pending', async ({}, testInfo) => {
    const original = '# Plan\n\nShip Friday.\n\nOwner note.\n'
    const mixed = '# Plan\n\nShip Thursday after review.\n\nUpdated owner note.\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A']])
    await agentEdits(value, engine, 't1', 'Ship Friday.', 'Friday', 'Thursday')

    await setSource(value.page!, mixed)
    await value.waitForBuffer(mixed)
    await save(value.page!)

    expect(await readFile(value.file, 'utf8')).toBe(mixed)
    await waitForReviewAction(value, 'Keep')
    expect(externalText(await value.inspectDocument())).toContain('Ship Thursday')
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
    await value.page!.keyboard.press(primaryKey('s'))

    const dialog = value.page!.getByRole('dialog', { name: /changed outside StrataMD while you were editing/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/changed (?:on disk )?while/i)
    expect(await readFile(value.file, 'utf8')).toBe(incoming)
    // Save was refused, not deferred: the unsaved edit is still only in the buffer.
    expect(await readFile((await value.inspectDocument()).buffer!, 'utf8')).toBe(mine)
  })

  test('6. crash recovery offers Recover without replacing the newer buffer', async ({}, testInfo) => {
    const original = '# Recovery\n\nSaved text.\n'
    const unsaved = '# Recovery\n\nUnsaved text survives.\n'
    const value = await scenario(testInfo, original)
    await value.launch()
    await setSource(value.page!, unsaved)
    await value.waitForBuffer(unsaved)
    const buffer = (await value.inspectDocument()).buffer!
    await value.stop(true)

    await value.launch()
    const dialog = value.page!.getByRole('dialog', { name: /Recover unsaved edits/i })
    await expect(dialog).toBeVisible()
    expect(await readFile(value.file, 'utf8')).toBe(original)
    expect(await readFile(buffer, 'utf8')).toBe(unsaved)
    await dialog.getByRole('button', { name: /Recover my edits/i }).click()
    await expect.poll(async () => (await value.inspectDocument()).document).toBe(unsaved)
  })

  test('6b. undo walks later typing, the agent merge, and earlier typing in order', async ({}, testInfo) => {
    const original = '# Undo\n\nBase.\n'
    const ownerEdit = '# Undo\n\nBase. Owner\n'
    const externalEdit = '# Undo\n\nBase. Owner Agent.\n'
    const laterEdit = '# Undo\n\nBase. Owner Agent. Later\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A']])

    const editor = value.page!.getByRole('textbox', { name: /document editor/i })
    await editor.locator('p').filter({ hasText: 'Base.' }).click({ position: { x: 4, y: 8 } })
    await value.page!.keyboard.press(lineEndKey)
    await value.page!.keyboard.type(' Owner')
    await value.waitForBuffer(ownerEdit)

    await agentEdits(value, engine, 't1', 'Base. Owner', 'Base. Owner', 'Base. Owner Agent.')
    await editor.locator('p').filter({ hasText: 'Base.' }).click({ position: { x: 4, y: 8 } })
    await value.page!.keyboard.press(lineEndKey)
    await value.page!.keyboard.type(' Later')
    await value.waitForBuffer(laterEdit)

    await editor.focus()
    await value.page!.keyboard.press(primaryKey('z'))
    await value.waitForBuffer(externalEdit)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(1)

    await editor.focus()
    await value.page!.keyboard.press(primaryKey('z'))
    await expect.poll(async () => (await value.inspectDocument()).document).toBe(ownerEdit)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)
    // The reversal reaches the agent as a user hunk on the next Send.
    await send(value.page!)
    await expect.poll(() => uploadsFor(engine, 't1').length).toBe(2)
    expect(uploadsFor(engine, 't1')[1]).toContain('-Base. Owner Agent.')

    // Send ends the application history; typing history continues across it.
    await editor.focus()
    await value.page!.keyboard.press(primaryKey('z'))
    await value.waitForBuffer(original)
  })

  test('7. Discard on close removes buffer-only pending hunks on reopen', async ({}, testInfo) => {
    const original = '# Close\n\nDisk text.\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A']])
    await agentEdits(value, engine, 't1', 'Disk text.', 'Disk text.', 'Agent-only buffer text.')

    await closeTab(value, 'Discard')
    await reopen(value)
    expect(await readFile((await value.inspectDocument()).buffer!, 'utf8')).toBe(original)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)
    expect(allHunks(await value.inspectDocument())).toHaveLength(0)
  })

  test('8. renaming an open file moves its one session and ghost entry', async ({}, testInfo) => {
    const value = await scenario(testInfo, '# Rename\n\nFollow me.\n')
    await value.writeSettings({ explorerFolders: [dirname(value.file)] })
    await value.launch()
    await value.inspectDocument()
    const docsRoot = join(String(value.env.XDG_DATA_HOME), 'stratamd/docs')
    const beforeEntries = await readdir(docsRoot)
    expect(beforeEntries).toHaveLength(1)

    const movedDirectory = join(dirname(value.file), 'moved')
    await mkdir(movedDirectory)
    const renamed = join(movedDirectory, 'renamed.md')
    await rename(value.file, renamed)
    const target = await realpath(renamed)
    await expect.poll(async () => value.page!.evaluate(async () => (await window.strata.getState()).activeDocument?.path)).toBe(target)
    expect(await value.page!.evaluate(async () => (await window.strata.getState()).tabs.map((tab) => tab.path))).toEqual([target])
    expect(await readdir(docsRoot)).toEqual(beforeEntries)
  })

  test('9. a mismatched suggestion becomes orphaned and cannot be accepted', async ({}, testInfo) => {
    const original = '# Suggestion\n\nThe exact quoted sentence.\n'
    const changed = '# Suggestion\n\nThe user replaced that sentence.\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A']])
    agentActs(engine, 't1', [{ verb: 'suggest', anchor: { document: value.file, quote: 'The exact quoted sentence.' }, replacement: 'A proposed replacement.' }])
    await annotationByText(value, 'A proposed replacement.')

    await setSource(value.page!, changed)
    await value.waitForBuffer(changed)
    await save(value.page!)
    await closeTab(value)
    await reopen(value)

    await expect.poll(async () => (await value.inspectDocument()).annotations?.find((item) => item.kind === 'suggestion')?.status).toBe('orphaned')
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
    await value.page!.evaluate(() => (document.querySelector('.annotation-composer') as HTMLFormElement).requestSubmit())

    await expect.poll(async () => (await value.inspectDocument()).annotations?.find((item) => item.text === 'Cross-block note')?.quote)
      .toBe('tail.\n\nBeta')
  })

  test('10. real corpus files no-op byte round-trip and strong edits stay local', async ({}, testInfo) => {
    // Every real corpus file round-trips byte-for-byte in
    // test/unit/markdown-serializer.test.ts; one file here proves the app's
    // save path does the same and keeps a strong edit local.
    const cases = [
      ['launch-queue-index.md', 'navigation index']
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
    const { value, engine } = await engineScenario(testInfo, '# Own writes\n\nOriginal.\n')
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A']])
    await setSource(value.page!, edited)
    await value.waitForBuffer(edited)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)

    await save(value.page!)
    expect(await readFile(value.file, 'utf8')).toBe(edited)
    await expect(value.page!.getByRole('button', { name: /^Keep(?:\b|$)/i })).toHaveCount(0)
    expect((await value.inspectDocument()).segments ?? []).toHaveLength(0)
  })

  test('12. an unacknowledged delivery survives close, restart, and the engine coming back', async ({}, testInfo) => {
    const { value, engine } = await engineScenario(testInfo, '# Durable queue\n\nOriginal.\n')
    await value.launch()
    await openThread(value.page!, 'Agent A')
    await attachThread(value.page!, engine, 't1', 'Agent A')
    engine.setOnline(false)
    await expect(value.page!.getByRole('button', { name: 'Engine status' })).toHaveText(/Disconnected/)

    const edited = `# Durable queue\n\nQueued user edit.\n\n${'durable payload '.repeat(20_000)}\n`
    await setSource(value.page!, edited)
    await value.waitForBuffer(edited)
    await value.page!.keyboard.press(primaryKey('s'))
    await expect.poll(() => readFile(value.file, 'utf8'), { timeout: 15_000 }).toBe(edited)
    await send(value.page!)
    const queued = await value.page!.evaluate(async () => (await window.strata.getState()).activeDocument?.attachments[0]?.queuedDeliveries ?? [])
    expect(queued).toHaveLength(1)

    // Close through the public API: this scenario tests durable delivery across closure,
    // while the other close scenarios exercise the Docs menu and its decisions.
    expect(await value.page!.evaluate(path => window.strata.closeDocument(path), value.file)).toBe('closed')
    await value.stop()
    await value.launch()
    engine.setOnline(true)
    await expect.poll(() => uploadsFor(engine, 't1').length, { timeout: 15_000 }).toBe(2)
    const turns = engine.commands.filter((command) => command.type === 'thread.turn.start')
    expect((turns[1]!.message as { messageId: string }).messageId).toBe(queued[0])
    expect(uploadsFor(engine, 't1')[1]).toContain('Queued user edit.')
  })

  for (const includeExternal of [false, true]) test(`14. another agent's edit is ${includeExternal ? 'explicitly included for a new agent' : 'excluded by default'}`, async ({}, testInfo) => {
    const original = '# Isolation\n\nShared paragraph.\n\nOwner line.\n'
    const withUserEdit = '# Isolation\n\nAgent B private edit.\n\nOwner line updated.\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A'], ['t2', 'Agent B']])
    let agentC = ''
    if (includeExternal) {
      // A third thread, started from Projects, joins as Agent C.
      await value.page!.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
      await value.page!.getByRole('button', { name: 'New thread in Cockpit project', exact: true }).click()
      await value.page!.getByLabel('Message conversation').fill('Join this review.')
      await value.page!.getByLabel('Message conversation').press('Enter')
      await expect.poll(() => engine.commands.find((command) => command.type === 'thread.create')?.threadId).toBeTruthy()
      agentC = String(engine.commands.find((command) => command.type === 'thread.create')!.threadId)
      await value.page!.evaluate(async (id) => window.strata.updateEngineThread(id, { title: 'Agent C' }), agentC)
      await value.page!.getByRole('button', { name: 'Move to side' }).click()
      await openThread(value.page!, 'Agent C')
      await attachThread(value.page!, engine, agentC, 'Agent C')
    }
    await openThread(value.page!, 'Agent A')
    await value.page!.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()

    await agentEdits(value, engine, 't2', 'Shared paragraph.', 'Shared paragraph.', 'Agent B private edit.')
    expect(externalText(await value.inspectDocument())).toContain('Agent B private edit.')

    await setSource(value.page!, withUserEdit)
    await value.waitForBuffer(withUserEdit)
    await send(value.page!, { includeExternal, recipientNames: [includeExternal ? 'Agent C' : 'Agent A'] })
    const recipient = includeExternal ? agentC : 't1'
    await expect.poll(() => uploadsFor(engine, recipient).filter(Boolean).length).toBe(2)
    const delivered = uploadsFor(engine, recipient).filter(Boolean)[1]!
    expect(delivered).toContain('Owner line updated.')
    expect(delivered).toContain('Changes by user:')
    if (!includeExternal) {
      expect(delivered).not.toContain('Agent B private edit.')
      return
    }
    expect(delivered).toContain('Changes by Agent B (t2):')
    expect(delivered).toContain('Agent B private edit.')
  })


  test('15. Accept changes only the buffer, notifies its author, and reaches peers as user work', async ({}, testInfo) => {
    const original = '# Accept\n\nUse the original phrase here.\n'
    const { value, engine } = await engineScenario(testInfo, original)
    await value.launch()
    await attachAll(value, engine, [['t1', 'Agent A'], ['t2', 'Agent B']])

    agentActs(engine, 't1', [{ verb: 'suggest', anchor: { document: value.file, quote: 'the original phrase' }, replacement: 'the accepted phrase' }])
    const suggestion = await annotationByText(value, 'the accepted phrase')
    await waitForReviewAction(value, 'Accept')
    await value.page!.getByRole('button', { name: /^Accept(?:\b|$)/i }).first().click()

    const accepted = '# Accept\n\nUse the accepted phrase here.\n'
    await value.waitForBuffer(accepted)
    expect(await readFile(value.file, 'utf8')).toBe(original)
    await send(value.page!, { recipientNames: ['Agent A', 'Agent B'] })

    await expect.poll(() => uploadsFor(engine, 't1').length).toBe(2)
    await expect.poll(() => uploadsFor(engine, 't2').length).toBe(2)
    expect(uploadsFor(engine, 't1')[1]).toContain(`${suggestion.id} (suggestion) was accepted.`)
    const peer = uploadsFor(engine, 't2')[1]!
    expect(peer).toContain('Changes by user:')
    expect(peer).toContain('+Use the accepted phrase here.')
    expect(await readFile(value.file, 'utf8')).toBe(original)
  })
})
