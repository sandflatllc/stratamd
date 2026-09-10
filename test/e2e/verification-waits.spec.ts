import { expect, test } from './test'
import { readFile } from 'node:fs/promises'
import { Scenario, save, setSource } from './harness'

test('evidence cleanup tolerates an already-closed Electron client', async ({}, info) => {
  const scenario = await Scenario.create(info, '# Closed client\n')
  try {
    await scenario.launch()
    await scenario.app!.close()
    await expect(scenario.captureEvidence()).resolves.toBeUndefined()
  } finally { await scenario.dispose() }
})

// The setup helper must observe each completed request even when the earlier
// toast is still visible and the requested save does not change any bytes.
test('successive no-op and edited saves each acknowledge their own request', async ({}, info) => {
  const original = '# Save request\n\nOriginal.\n'
  const scenario = await Scenario.create(info, original)
  try {
    const page = await scenario.launch()
    const issued = () => page.evaluate(() => (window.strata as unknown as { saveDiagnostics(): { issued: number; completed: { request: number; error: string | null } } }).saveDiagnostics())
    await save(page)
    await expect(page.getByRole('status')).toContainText('Saved.')
    await save(page)
    expect(await readFile(scenario.file, 'utf8')).toBe(original)
    expect(await issued()).toMatchObject({ issued: 2, completed: { request: 2, error: null } })
    const edited = '# Save request\n\nEdited.\n'
    await setSource(page, edited)
    await save(page)
    expect(await readFile(scenario.file, 'utf8')).toBe(edited)
    expect(await issued()).toMatchObject({ issued: 3, completed: { request: 3, error: null } })
  } finally { await scenario.dispose() }
})

test('attachment waits for this delivery even when an older turn for the same thread exists', async ({}, info) => {
  const { seededScenario, startEngine } = await import('./cockpit-engine-harness')
  const { attachThread } = await import('./cockpit-agent')
  const engine = await startEngine({ titles: { t1: 'Agent A' } })
  const scenario = await seededScenario(info, engine.origin, '# Attach\n\nOriginal.\n')
  try {
    const page = await scenario.launch()
    await attachThread(page, engine, 't1')
    engine.postAssistant('t1', 'First turn finished.')
    await setSource(page, '# Attach\n\nSecond delivery.\n')
    await scenario.waitForBuffer('# Attach\n\nSecond delivery.\n')
    // Withhold only the observer's new command. The app still uploads and
    // dispatches through the real HTTP/WebSocket fixture.
    const observed = { ...engine, commands: [...engine.commands] }
    const oldCount = engine.commands.length
    let returned = false
    const attaching = attachThread(page, observed, 't1').then(() => { returned = true })
    await expect.poll(() => engine.commands.length).toBeGreaterThan(oldCount)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(returned).toBe(false)
    observed.commands.push(...engine.commands.slice(oldCount))
    await attaching
    expect(returned).toBe(true)
    engine.postAssistant('t1', 'Matching turn finished.')
  } finally { await scenario.dispose(); await engine.close() }
})
