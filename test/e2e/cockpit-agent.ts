import { expect, type Page } from '@playwright/test'
import { selectNavigationTab, type Annotation, type Scenario } from './harness'
import type { FakeEngine } from './cockpit-engine-harness'

/**
 * Agent-side helpers for cockpit e2e: a thread attaches to the open document
 * by sending to it (§5.7), and an agent acts by posting a strata block in its
 * thread, which the app applies to the attached document (§5.9).
 */

export async function openThread(page: Page, name: string): Promise<void> {
  await selectNavigationTab(page, 'Projects')
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click()
  // Thread selection updates the title before its delayed navigation finishes.
  const conversation = page.locator('.conversation-panel:visible')
  await expect(conversation).toBeVisible()
  await expect(conversation.locator('.conversation-title')).toContainText(name)
}

/** Attaches the thread by sending the active document to it, and waits until the row shows under Attached. */
export async function attachThread(page: Page, engine: FakeEngine, threadId: string, name?: string): Promise<void> {
  const deliveries = await page.evaluate(async (id) => {
    const document = (await window.strata.getState()).activeDocument!
    const request = { recipients: [id], note: '', includeExternal: false }
    const [preview] = await window.strata.previewSend(document.path, request)
    return window.strata.send(document.path, { ...request, token: preview!.token })
  }, threadId)
  expect(deliveries).toHaveLength(1)
  await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start'
    && command.threadId === threadId
    && (command.message as { messageId?: string }).messageId === deliveries[0])).toBe(true)
  if (name) await expect(page.locator('.agent-row').filter({ hasText: name })).toBeVisible()
}

export type StrataEntry = Record<string, unknown>

/** The agent posts a completed message whose strata block carries `entries`. Returns the message id. */
export function agentActs(engine: FakeEngine, threadId: string, entries: StrataEntry[], prose = 'Done.'): string {
  return engine.postAssistant(threadId, `${prose}\n\n\`\`\`strata\n${JSON.stringify(entries)}\n\`\`\``)
}

/** The agent edits the document: `match` inside the block that contains `quote` becomes `replace`. */
export function agentEdits(engine: FakeEngine, threadId: string, document: string, quote: string, match: string, replace: string): string {
  return agentActs(engine, threadId, [{ verb: 'edit', anchor: { document, quote }, match, replace }])
}

/** Waits for the annotation the agent created and returns it. */
export async function annotationByText(scenario: Scenario, text: string): Promise<Annotation> {
  await expect.poll(async () => (await scenario.inspectDocument()).annotations?.some((item) => item.text === text)).toBe(true)
  return (await scenario.inspectDocument()).annotations!.find((item) => item.text === text)!
}

/** Every delivery text the app uploaded for the thread's turns, oldest first. */
export function uploadsFor(engine: FakeEngine, threadId: string): string[] {
  const turns = engine.commands.filter((command) => command.type === 'thread.turn.start' && command.threadId === threadId)
  return turns.map((turn) => {
    const attachments = (turn.message as { attachments?: Array<{ id?: string }> }).attachments ?? []
    return engine.uploadsById.get(String(attachments[0]?.id ?? '')) ?? ''
  })
}
