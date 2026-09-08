import { test, expect } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { settledBox } from './geometry'
import { seedAsks } from './inferred-asks-fixture'

for (const placement of ['side', 'center'] as const) test(`passage answer popup preserves layout, drafts, navigation and queued edits in ${placement}`, async ({},testInfo)=>{
  const engine=await startEngine(), scenario=await seededScenario(testInfo,engine.origin)
  const questions=['Where should the icon go?', 'Which replies should be scanned?']
  const source=`${questions[0]}\n\nKeep the surrounding explanation visible.\n\n${questions[1]}`
  const asks=await seedAsks(scenario,source,questions)
  engine.setMessage(source)
  try {
    const page=await scenario.launch()
    await page.getByRole('tablist',{name:'Document navigation'}).getByRole('tab',{name:'Projects'}).click()
    await page.getByRole('button',{name:/^Open Live engine thread$/}).click()
    if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
    await page.getByRole('button',{name:'Stop',exact:true}).click()
    const first=page.getByRole('button',{name:`Answer question: ${questions[0]}`,exact:true})
    const popup=page.getByRole('dialog',{name:'Your answer'}), field=popup.getByRole('textbox',{name:'Your answer'})
    // The rail reveals and promotes an offscreen lightweight passage first.
    await page.getByRole('button',{name:`Question: ${questions[0]}`,exact:true}).click()
    await expect(field).toBeFocused()
    await expect.poll(()=>page.evaluate(()=>window.strataTranscript?.snapshot().events.filter(event=>event.kind==='navigated').length ?? 0)).toBe(1)
    await expect(first).toBeInViewport({ratio:1}).catch(async error=>{await testInfo.attach('navigation-diagnostic.json',{contentType:'application/json',body:JSON.stringify(await page.evaluate(()=>({diagnostics:window.strataTranscript?.snapshot(),elements:Array.from(document.querySelectorAll('.conversation-messages, [data-message-id="m1"], [data-ask-id]')).map(el=>({tag:el.tagName,classes:el.className,rect:el.getBoundingClientRect().toJSON(),scrollTop:el.scrollTop,scrollHeight:el.scrollHeight}))})),null,2)});throw error})
    await expect(page.locator('[data-message-id="m1"] [data-rich-mounted]')).toBeVisible()
    await popup.getByRole('button',{name:'Close answer'}).click()
    const before=await settledBox(page, first)
    await first.click()
    await expect(field).toBeFocused()
    await expect(popup).not.toContainText(questions[0]!)
    const box=await settledBox(page,popup)
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y+box.height).toBeLessThanOrEqual(viewport.height)
    await page.screenshot({path:testInfo.outputPath('answer-popup.png')})
    await expect.poll(async()=> (await first.boundingBox())?.y).toBe(before!.y)
    await field.fill('Use the same row.')
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await first.click()
    await expect(field).toHaveValue('Use the same row.')
    await popup.getByRole('button',{name:'Cancel',exact:true}).click()
    await page.getByRole('button',{name:`Question: ${questions[1]}`,exact:true}).click()
    await expect(field).toHaveValue('')
    await popup.getByRole('button',{name:'Close answer'}).click()
    await first.click()
    await field.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Message conversation' }).filter({ visible: true })).toBeFocused()
    await expect(first).toHaveText('✓ Drafted')
    await first.click()
    await field.fill('Keep the icon alone on that row.')
    await popup.getByRole('button',{name:'Cancel',exact:true}).click()
    await expect.poll(()=>page.evaluate(id=>window.strata.getState().then(state=>state.engine.projects.flatMap(p=>p.threads).find(t=>t.id==='t1')?.items?.find(i=>i.id===id)?.draftReply),asks[0]!.id)).toBe('Use the same row.')
    await first.click()
    await expect(field).toHaveValue('Keep the icon alone on that row.')
    await popup.getByRole('button',{name:'Hold'}).click()
    await expect.poll(()=>page.evaluate(id=>window.strata.getState().then(state=>state.engine.projects.flatMap(p=>p.threads).find(t=>t.id==='t1')?.items?.filter(i=>i.id===id&&i.draftReply).map(i=>i.draftReply)),asks[0]!.id)).toEqual(['Keep the icon alone on that row.'])
    await page.evaluate(async()=>{const state=await window.strata.getState();await window.strata.updateSettings({zoom:{...state.settings.zoom,explorer:1.2,editor:1.2}})})
    await first.click()
    await expect(field).toBeFocused()
    const zoomBox=await settledBox(page,popup)
    expect(zoomBox.x+zoomBox.width).toBeLessThanOrEqual(viewport.width)
    expect(zoomBox.y+zoomBox.height).toBeLessThanOrEqual(viewport.height)
    await page.screenshot({path:testInfo.outputPath('answer-popup-zoom.png')})
    await popup.getByRole('button', { name: 'Close answer' }).click()
    // The cleared thread view can arrive before the discard acknowledgment.
    // Reopening and editing in that interval must outlive the old completion.
    await scenario.app!.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
      const original = handlers.get('strata:discard-item-reply')!
      const gate = { waiting: false, release: () => {} }
      const ready = new Promise<void>(resolve => { gate.release = resolve })
      Object.assign(globalThis, { __discardReplyGate: gate })
      handlers.set('strata:discard-item-reply', async (...args) => {
        const result = await original(...args)
        gate.waiting = true
        await ready
        return result
      })
    })
    await page.getByRole('button', { name: 'Remove held reply: Keep the icon alone on that row.' }).click()
    await expect.poll(() => scenario.app!.evaluate(() => (globalThis as unknown as { __discardReplyGate: { waiting: boolean } }).__discardReplyGate.waiting)).toBe(true)
    await expect(first).not.toHaveText('✓ Drafted')
    await first.click()
    await expect(field).toHaveValue('')
    await field.fill('A fresh answer after removal.')
    await scenario.app!.evaluate(() => (globalThis as unknown as { __discardReplyGate: { release(): void } }).__discardReplyGate.release())
    await page.evaluate(async () => {
      await window.strata.getState()
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    await expect(field).toHaveValue('A fresh answer after removal.')
    await field.press('Enter')
    await expect(page.getByRole('button', { name: 'Remove held reply: A fresh answer after removal.' })).toBeVisible()
    await first.click()
    await expect(field).toHaveValue('A fresh answer after removal.')
    await page.getByRole('button',{name:'StrataMD menu'}).click()
    await expect(popup).toHaveCount(0)
  } finally {
    await scenario.app?.evaluate(() => (globalThis as unknown as { __discardReplyGate?: { release(): void } }).__discardReplyGate?.release()).catch(() => undefined)
    await scenario.dispose();await engine.close()
  }
})

test('an ask decoration resize preserves the passage being read inside a long reply', async ({}, testInfo) => {
  const engine = await startEngine(), scenario = await seededScenario(testInfo, engine.origin)
  const source = 'Which date?\n\n' + Array.from({ length: 24 }, (_, i) => `Reading passage ${i}. Keep this text in place.`).join('\n\n')
  const asks = await seedAsks(scenario, source, ['Which date?'])
  engine.setMessage(source)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Open in center' }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await page.getByRole('button', { name: 'Question: Which date?', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.strataTranscript?.snapshot().events.some(e => e.kind === 'navigated'))).toBe(true)
    await page.getByRole('button', { name: 'Close answer' }).click()
    const row = page.locator('[data-message-id="m1"]'), sentinel = row.locator('.strata-prosemirror p').filter({ hasText: /^Reading passage 12\./ })
    await sentinel.evaluate(el => { const v = el.closest('.conversation-messages')!; v.scrollTop += el.getBoundingClientRect().top - v.getBoundingClientRect().top - parseFloat(getComputedStyle(v).paddingTop) })
    await expect(page.locator('.conversation-messages')).not.toHaveAttribute('data-scroll-active', 'true')
    const before = await settledBox(page, sentinel)
    // Force a known decoration-height change, as a late tag or wrapping label
    // can cause, without changing any source text or the reading target.
    await page.addStyleTag({ content: '.conversation-ask-tag[data-status="drafted"] { padding-block: 40px; }' })
    await page.evaluate(id => window.strata.queueItemReply('t1', id, 'Friday'), asks[0]!.id)
    await expect(row.locator('.conversation-ask-tag')).toHaveAttribute('data-status', 'drafted')
    await expect.poll(async () => Math.abs((await sentinel.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2)
    expect((await row.locator('.conversation-ask-tag').boundingBox())!.height).toBeGreaterThan(80)
  } finally { await scenario.dispose(); await engine.close() }
})
