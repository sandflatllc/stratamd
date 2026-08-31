import { describe, expect, it } from 'vitest'
import {
  hasOnlyPrimaryModifier,
  hasPrimaryModifier,
  isMacLike,
  primaryModifierLabel,
} from '../../src/shared/primary-modifier'

describe('primary modifier helper', () => {
  it('detects Mac platforms from the navigator hint', () => {
    expect(isMacLike('MacIntel')).toBe(true)
    expect(isMacLike('MacARM')).toBe(true)
    expect(isMacLike('Linux x86_64')).toBe(false)
    expect(isMacLike('')).toBe(false)
  })

  it('treats Control as primary off Mac and Command as primary on Mac', () => {
    expect(hasPrimaryModifier({ ctrlKey: true, metaKey: false }, false)).toBe(true)
    expect(hasPrimaryModifier({ ctrlKey: false, metaKey: true }, false)).toBe(false)
    expect(hasPrimaryModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true)
    expect(hasPrimaryModifier({ ctrlKey: true, metaKey: false }, true)).toBe(false)
  })

  it('rejects chords that also hold the other platform modifier', () => {
    expect(hasOnlyPrimaryModifier({ ctrlKey: true, metaKey: false }, false)).toBe(true)
    expect(hasOnlyPrimaryModifier({ ctrlKey: true, metaKey: true }, false)).toBe(false)
    expect(hasOnlyPrimaryModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true)
    expect(hasOnlyPrimaryModifier({ ctrlKey: true, metaKey: true }, true)).toBe(false)
  })

  it('labels the primary modifier for visible hints', () => {
    expect(primaryModifierLabel(false)).toBe('Ctrl')
    expect(primaryModifierLabel(true)).toBe('Cmd')
  })
})
