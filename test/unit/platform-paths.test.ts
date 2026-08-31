import { describe, expect, it } from 'vitest'
import {
  getCliLinkPath,
  getConfigDirectory,
  getDataDirectory,
  getSocketLocation,
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

  it('prefers an absolute runtime directory for the socket on both platforms', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(getSocketLocation({ platform, env: { XDG_RUNTIME_DIR: '/run/user/7' }, home })).toEqual({
        path: '/run/user/7/stratamd.sock',
        ownedParent: false,
      })
    }
  })

  it('treats a relative runtime directory as unset', () => {
    expect(getSocketLocation({ platform: 'linux', env: { XDG_RUNTIME_DIR: 'run' }, home }).path).toBe(
      '/home/test/.cache/stratamd/run/stratamd.sock',
    )
    expect(getSocketLocation({ platform: 'darwin', env: { XDG_RUNTIME_DIR: 'run' }, home }).path).toBe(
      '/home/test/Library/Caches/StrataMD/run/stratamd.sock',
    )
  })

  it('falls back to an owned cache directory for the socket', () => {
    expect(getSocketLocation({ platform: 'linux', env: {}, home })).toEqual({
      path: '/home/test/.cache/stratamd/run/stratamd.sock',
      ownedParent: true,
    })
    expect(getSocketLocation({ platform: 'darwin', env: {}, home })).toEqual({
      path: '/home/test/Library/Caches/StrataMD/run/stratamd.sock',
      ownedParent: true,
    })
  })

  it('uses the per-user temporary directory on macOS before the cache fallback', () => {
    expect(getSocketLocation({ platform: 'darwin', env: { TMPDIR: '/var/folders/ab/T/' }, home })).toEqual({
      path: '/var/folders/ab/T/stratamd.sock',
      ownedParent: false,
    })
    expect(getSocketLocation({ platform: 'darwin', env: { TMPDIR: 'tmp' }, home }).ownedParent).toBe(true)
    // TMPDIR is a Mac convention; the Linux fallback ignores it.
    expect(getSocketLocation({ platform: 'linux', env: { TMPDIR: '/var/folders/ab/T/' }, home }).path).toBe(
      '/home/test/.cache/stratamd/run/stratamd.sock',
    )
  })

  it('ignores XDG_CACHE_HOME so client and server derive one socket path', () => {
    for (const platform of ['linux', 'darwin']) {
      const withCache = getSocketLocation({ platform, env: { XDG_CACHE_HOME: '/other' }, home })
      expect(withCache).toEqual(getSocketLocation({ platform, env: {}, home }))
    }
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
