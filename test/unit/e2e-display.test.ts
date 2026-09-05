import { describe, expect, it } from 'vitest'
import { DISPLAYS_VARIABLE, parseDisplays } from '../e2e/display'

describe('per-worker display list', () => {
  it('is absent when the variable is unset or blank', () => {
    expect(parseDisplays(undefined)).toBeUndefined()
    expect(parseDisplays('')).toBeUndefined()
    expect(parseDisplays('  ')).toBeUndefined()
  })

  it('splits a comma-separated list of X displays', () => {
    expect(parseDisplays(':99,:100, :101.0')).toEqual([':99', ':100', ':101.0'])
  })

  it('names the entry that is not an X display', () => {
    expect(() => parseDisplays(':99,localhost:1')).toThrow(`${DISPLAYS_VARIABLE} holds "localhost:1"`)
  })
})
