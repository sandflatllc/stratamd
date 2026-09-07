import { describe, expect, it } from 'vitest'
import { shortPlan, shortResetLabel, usageTone } from '../../src/renderer/components/AccountsDialog'

describe('accounts dialog labels', () => {
  it('drops the vendor and the word Subscription from plan names', () => {
    expect(shortPlan('Claude Max Subscription')).toBe('Max')
    expect(shortPlan('ChatGPT Pro 20x Subscription')).toBe('Pro 20x')
    expect(shortPlan('ChatGPT Free Subscription')).toBe('Free')
    expect(shortPlan('Pro')).toBe('Pro')
    expect(shortPlan('Subscription')).toBe('Subscription')
  })

  it('shortens reset times to what the reader needs', () => {
    const now = new Date(2026, 8, 4, 18, 0).getTime()
    expect(shortResetLabel(new Date(2026, 8, 4, 21, 50).toISOString(), now)).toBe('9:50 PM')
    expect(shortResetLabel(new Date(2026, 8, 7, 21, 0).toISOString(), now)).toBe('Mon 9 PM')
    expect(shortResetLabel(new Date(2026, 8, 7, 1, 28).toISOString(), now)).toBe('Mon 1:28 AM')
    expect(shortResetLabel(new Date(2026, 8, 11, 16, 16).toISOString(), now)).toBe('Sep 11 4:16 PM')
    expect(shortResetLabel(new Date(2026, 8, 1, 9, 0).toISOString(), now)).toBe('Sep 1 9 AM')
    expect(shortResetLabel(new Date(2026, 8, 7, 6, 59, 59, 780).toISOString(), now)).toBe('Mon 7 AM')
    expect(shortResetLabel('not a date', now)).toBe('not a date')
  })

  it('colors usage by pressure', () => {
    expect(usageTone(0)).toBe('ok')
    expect(usageTone(59)).toBe('ok')
    expect(usageTone(60)).toBe('warn')
    expect(usageTone(85)).toBe('hot')
  })
})

it('shows Fable separately, keeps other models selectable, and labels expired readings', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { AccountsDialog } = await import('../../src/renderer/components/AccountsDialog')
  const { ModelPicker } = await import('../../src/renderer/components/ModelPicker')
  const { EMPTY_VIEW } = await import('../../src/renderer/model')
  const { accountViews, emptyAccountsStore } = await import('../../src/main/engine/accounts')
  const now = Date.now()
  const measuredAt = new Date(now).toISOString()
  const resetsAt = new Date(now + 3600000).toISOString()
  const accounts = accountViews(emptyAccountsStore(), [{ instanceId: 'claude', driver: 'claudeAgent', displayName: 'Claude Work', homePath: '/work', installed: true, enabled: true, status: 'ready', auth: { status: 'authenticated' }, usage: { session: { usedPercent: 0, measuredAt, resetsAt: null }, weekly: { usedPercent: 51, measuredAt, resetsAt }, modelWindows: [{ model: 'Fable', usedPercent: 100, measuredAt, resetsAt }], applicable: true } }], now)
  const engine = { ...EMPTY_VIEW.engine, state: 'connected' as const, accounts }
  const html = renderToStaticMarkup(createElement(AccountsDialog, { engine, onPark() {}, onTerminalDefault() {}, onClose() {} }))
  expect(html).toContain('Fable limit reached')
  expect(html).toContain('aria-label="Fable usage"')
  expect(html).toContain('aria-label="All models usage"')
  expect(html.indexOf('data-window="fable"')).toBeLessThan(html.indexOf('data-window="session"'))
  expect(html).toContain('>Refresh</button>')
  const models = ['fable', 'sonnet'].map(model => ({ instanceId: 'claude', driver: 'claudeAgent', accountName: 'Claude Work', slug: `claude-${model}-5`, name: model, options: [] }))
  const picker = renderToStaticMarkup(createElement(ModelPicker, { models, accounts, selection: { instanceId: 'claude', model: 'claude-fable-5', effort: null, access: 'full-access' }, onSelect() {} }))
  expect(picker).toMatch(/aria-label="Use fable"[^>]*disabled=""[^>]*title="Fable limit reached"/)
  expect(picker).toMatch(/aria-label="sonnet"[^>]*aria-pressed="false">/)
  const old = { ...accounts[0]!, state: 'stale' as const, session: { usedPercent: 6, measuredAt: new Date(now - 3600000).toISOString(), resetsAt: new Date(now - 1800000).toISOString() }, modelWindows: [] }
  const stale = renderToStaticMarkup(createElement(AccountsDialog, { engine: { ...engine, accounts: [old] }, onPark() {}, onTerminalDefault() {}, onClose() {} }))
  expect(stale).toContain('Reset passed')
  expect(stale).toContain('Fable usage not reported')
  expect(stale).toContain('Usage out of date')
})
