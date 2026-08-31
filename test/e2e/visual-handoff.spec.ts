import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Scenario, setSource } from './harness'

const DOCUMENT = `---
owner: me
status: draft
---

# Rollout plan

We ship the importer first, then the sync layer while keeping the CLI stable.

The test corpus covers every construct in section 6.1 plus real documents that round-tripped badly.

While attached, agents write only to the buffer file; the document on disk is yours to save.

## Next steps

- [ ] Wire the watcher to the ghost store
- [x] Land the byte-preserving save
`

test('populated renderer preserves the handoff tokens, controls, and motion policy', async ({}, testInfo) => {
  const value = await Scenario.create(testInfo, DOCUMENT, 'plan.md')
  const documentRoot = dirname(value.file)
  const notes = join(documentRoot, 'notes.md')
  await Promise.all([
    writeFile(notes, '# Notes\n\nReview notes for the rollout.\n'),
    writeFile(join(documentRoot, 'spec.md'), '# Specification\n\nSee section 6.1.\n'),
    writeFile(join(documentRoot, 'old-draft.md'), '# Old draft\n\nSuperseded.\n')
  ])
  await value.writeSettings({
    explorerFolders: [documentRoot],
    panels: {
      explorerWidth: 212,
      rightRailWidth: 300,
      changesHeight: 260,
      annotationsHeight: 180,
      documentMeasure: 860
    }
  })

  try {
    const page = await value.launch()
    await page.setViewportSize({ width: 1600, height: 900 })
    expect((await value.attach('claude', 'Claude')).event).toBe('initial')
    expect((await value.attach('haru', 'Haru')).event).toBe('initial')

    await page.evaluate(async (path) => window.strata.openDocument(path), notes)
    await expect(page.getByRole('tab', { name: /notes\.md/i })).toBeVisible()
    await page.evaluate(async (path) => window.strata.openDocument(path), value.file)

    const state = await value.state()
    const proposed = DOCUMENT.replace('then the sync layer', 'then the export path')
    await value.tag('claude', 'Claude')
    await value.atomicWrite(state.buffer!, proposed)
    await expect(page.getByRole('button', { name: /^Keep(?:\b|$)/i }).first()).toBeVisible()

    const suggestion = await value.cli([
      'annotate', value.file,
      '--kind', 'suggestion',
      '--quote', 'every construct',
      '--text', 'each construct',
      '--as', 'claude'
    ])
    expect(suggestion.code, suggestion.stderr).toBe(0)
    const question = await value.cli([
      'annotate', value.file,
      '--kind', 'question',
      '--quote', 'the document on disk is yours to save',
      '--text', 'Confirm Save remains the only document write.',
      '--as', 'claude'
    ])
    expect(question.code, question.stderr).toBe(0)
    await expect(page.getByRole('button', { name: /^Accept suggestion /i })).toBeVisible()
    await expect(page.locator('.annotation-row')).toHaveCount(2)

    await setSource(page, `${proposed}\nUser note.\n`)
    await value.waitForBuffer(`${proposed}\nUser note.\n`)
    await expect(page.locator('.strata-source-review-action')).toHaveCount(1)
    await expect(page.locator('.strata-source-review-action del')).toHaveText('sync layer')
    await expect(page.locator('.strata-source-review-action ins')).toHaveText('export path')
    await expect(page.locator('.strata-source-review-insertion')).toHaveText('export path')
    await expect(page.locator('.strata-source-review-insertion')).toHaveAttribute('data-deleted', 'sync layer')
    await expect(page.locator('.strata-source-suggestion-deletion')).toHaveText('every construct')
    await expect(page.locator('.strata-source-suggestion-deletion')).toHaveAttribute('data-replacement', 'each construct')
    await expect(page.locator('.strata-source-frontmatter')).toContainText('owner: me')
    await expect(page.locator('.strata-source-layer')).toHaveCSS('animation-name', 'slide-a')
    await page.screenshot({ path: testInfo.outputPath('handoff-source-review.png'), fullPage: true })
    await page.keyboard.press('Control+/')
    await expect(page.getByRole('textbox', { name: /source editor/i })).toBeHidden()
    await expect(page.locator('.ProseMirror')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Send(?:\b|$)/i })).toBeVisible()

    const visual = await page.evaluate(() => {
      const style = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) throw new Error(`Missing ${selector}`)
        const computed = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        return {
          background: computed.backgroundColor,
          backgroundImage: computed.backgroundImage,
          borderColor: computed.borderColor,
          borderRadius: computed.borderRadius,
          color: computed.color,
          fontSize: computed.fontSize,
          top: bounds.top
        }
      }
      return {
        shellMotion: document.querySelector('.app-shell')?.getAttribute('data-motion'),
        animationNames: document.getAnimations()
          .map((animation) => (animation as CSSAnimation).animationName)
          .filter(Boolean),
        animationStates: document.getAnimations().map((animation) => animation.playState),
        send: style('.send-button'),
        keep: style('.strata-review-controls button:first-of-type'),
        revert: style('.strata-review-controls button:last-of-type'),
        bold: style('.tool-bold'),
        save: style('.save-button')
      }
    })

    expect(visual.shellMotion).toBe('true')
    expect(visual.animationNames).toEqual(expect.arrayContaining([
      'ambient-wash-drift',
      'ambient-rise',
      'ambient-glow-1',
      'ambient-glow-2',
      'ambient-glow-3',
      'ambient-inner-a',
      'ambient-inner-b',
      'ambient-mote-wander'
    ]))
    expect(visual.animationStates).not.toContain('idle')
    expect(visual.send.backgroundImage).toContain('linear-gradient')
    expect(visual.keep.background).toBe('rgb(61, 201, 124)')
    expect(visual.revert.borderColor).toBe('rgb(255, 92, 138)')
    expect(visual.revert.color).toBe('rgb(255, 92, 138)')
    expect(visual.keep.borderRadius).toBe('999px')
    expect(visual.keep.fontSize).toBe('12px')
    expect(Math.abs(visual.bold.top - visual.save.top)).toBeLessThan(8)

    await page.locator('.strata-review-controls button:first-of-type').hover()
    await expect(page.locator('.strata-review-controls button:first-of-type')).not.toHaveCSS('box-shadow', 'none')
    await page.locator('.strata-review-controls button:last-of-type').hover()
    await expect(page.locator('.strata-review-controls button:last-of-type')).toHaveCSS('background-color', /rgba\(255, 92, 138, 0\.15\)|color\(srgb 1 0\.36\d* 0\.54\d* \/ 0\.15\)/)
    await page.locator('[data-task-checkbox="true"]').first().hover()
    await expect(page.locator('[data-task-checkbox="true"]').first()).not.toHaveCSS('transform', 'none')
    await expect(page.locator('.tool-bullet-list')).toHaveCSS('font-size', '17px')
    await expect(page.locator('.tool-ordered-list')).toHaveCSS('font-size', '12px')
    await expect(page.locator('.tool-image')).toHaveCSS('font-size', '12px')

    // The ambient ticker (src/renderer/ambientTicker.ts) pauses ambient CSS
    // animations and advances their currentTime at 30 Hz, so playState is
    // 'paused' by design. Motion means the animation clock advances.
    const sampleWashDrift = async () => page.evaluate(() =>
      document.getAnimations()
        .filter((animation) => (animation as CSSAnimation).animationName === 'ambient-wash-drift')
        .map((animation) => Number(animation.currentTime ?? 0))
    )
    const driftBefore = await sampleWashDrift()
    expect(driftBefore.length).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    const driftAfter = await sampleWashDrift()
    expect(driftAfter).toHaveLength(driftBefore.length)
    for (const [index, time] of driftAfter.entries()) expect(time).toBeGreaterThan(driftBefore[index]!)

    // PRD §6.12: ambient motion pauses while keystrokes arrive. Under the
    // ticker, data-typing="true" freezes the ambient clock entirely.
    await page.evaluate(() => document.documentElement.setAttribute('data-typing', 'true'))
    await page.waitForTimeout(300)
    const frozenFirst = await sampleWashDrift()
    await page.waitForTimeout(300)
    const frozenSecond = await sampleWashDrift()
    expect(frozenSecond).toEqual(frozenFirst)
    await page.evaluate(() => document.documentElement.removeAttribute('data-typing'))
    await page.waitForTimeout(300)
    const resumed = await sampleWashDrift()
    for (const [index, time] of resumed.entries()) expect(time).toBeGreaterThan(frozenSecond[index]!)
    await expect(page.locator('[data-frontmatter-chip="true"]')).toHaveText('▸ --- frontmatter · 2 keys ---')
    await expect(page.locator('[data-task-check-glyph="true"]')).toHaveText('✓')
    await expect(page.locator('[data-task-content="true"]').filter({ hasText: 'Land the byte-preserving save' })).toHaveCSS('text-decoration-line', 'line-through')
    await expect(page.locator('.strata-review-deletion')).toHaveText('sync layer')
    await expect(page.locator('.strata-review-change')).toHaveText('export path')
    await expect(page.locator('.strata-review-author').first()).toContainText('Claude')
    await page.getByRole('button', { name: /^Send(?:\b|$)/i }).click()
    const recipients = page.locator('.recipients label[data-selected="true"]')
    await expect(recipients).toHaveCount(2)
    // Selected-recipient text derives from the theme's bright interface text, not fixed white.
    await expect(recipients.first()).toHaveCSS('color', 'rgb(244, 243, 246)')
    await expect(recipients.first()).not.toHaveCSS('box-shadow', 'none')
    await expect(page.locator('.composer-send')).toHaveCSS('font-size', '15px')
    await page.keyboard.press('Escape')
    await page.mouse.move(800, 760)
    await expect(page.locator('.strata-suggestion-deletion')).toContainText('every construct')
    await expect(page.locator('.strata-suggestion-replacement')).toHaveText('each construct')
    await expect(page.locator('.strata-suggestion-author')).toHaveText('Claude · suggestion')
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.locator('.file-row')).toHaveCount(4)
    await expect(page.locator('.agent-row')).toHaveCount(2)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.screenshot({ path: testInfo.outputPath('handoff-populated.png'), fullPage: true })
    await page.setViewportSize({ width: 2048, height: 821 })
    await expect(page.locator('.app-shell')).toHaveCSS('width', '2048px')
    await expect(page.locator('.explorer')).toBeVisible()
    await expect(page.locator('.right-rail')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('handoff-ultrawide.png'), fullPage: true })
    const flashing = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.strata-review-controls button:first-of-type')?.click()
      return document.querySelectorAll('.is-flashing').length
    })
    expect(flashing).toBe(1)
    expect(await readFile(value.file, 'utf8')).toBe(DOCUMENT)
  } finally {
    await value.dispose()
  }
})
