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
    expect(shortResetLabel(new Date(2026, 8, 11, 16, 16).toISOString(), now)).toBe('Sep 11')
    expect(shortResetLabel(new Date(2026, 8, 1, 9, 0).toISOString(), now)).toBe('Sep 1')
    expect(shortResetLabel('not a date', now)).toBe('not a date')
  })

  it('colors usage by pressure', () => {
    expect(usageTone(0)).toBe('ok')
    expect(usageTone(59)).toBe('ok')
    expect(usageTone(60)).toBe('warn')
    expect(usageTone(85)).toBe('hot')
  })
})
