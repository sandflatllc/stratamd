import { describe, expect, it } from 'vitest'
import {
  getCliLinkPath,
  getConfigDirectory,
  getDataDirectory,
} from '../../src/platform/paths'
import { assertSupportedPlatform, isSupportedPlatform } from '../../src/platform/runtime'

const home = '/home/test'

describe('platform path resolution', () => {
  it('resolves config under XDG or ~/.config on both platforms', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(getConfigDirectory({ platform, env: {}, home })).toBe('/home/test/.config/stratamd')
      expect(getConfigDirectory({ platform, env: { XDG_CONFIG_HOME: '/cfg' }, home })).toBe('/cfg/stratamd')
    }
  })

  it('resolves data under XDG, ~/.local/share, or Application Support', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(getDataDirectory({ platform, env: { XDG_DATA_HOME: '/data' }, home })).toBe('/data/stratamd')
    }
    expect(getDataDirectory({ platform: 'linux', env: {}, home })).toBe('/home/test/.local/share/stratamd')
    expect(getDataDirectory({ platform: 'darwin', env: {}, home })).toBe(
      '/home/test/Library/Application Support/StrataMD',
    )
  })

  it('places the CLI link under ~/.local/bin on both platforms', () => {
    expect(getCliLinkPath(home)).toBe('/home/test/.local/bin/stratamd')
  })

  it('accepts only Linux and macOS as supported platforms', () => {
    expect(isSupportedPlatform('linux')).toBe(true)
    expect(isSupportedPlatform('darwin')).toBe(true)
    expect(isSupportedPlatform('win32')).toBe(false)
    expect(() => assertSupportedPlatform('win32')).toThrow(/Linux and macOS/)
    expect(assertSupportedPlatform('darwin')).toBe('darwin')
  })
})
