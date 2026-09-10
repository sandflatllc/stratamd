import { describe, expect, it } from 'vitest'
import {
  fontFamiliesFromFcList,
  fontFamiliesFromSystemProfiler,
  queryInstalledFontFamilies,
} from '../../src/platform/fonts'

// The SPFontsDataType shape system_profiler -json prints: one entry per font
// file, family names inside typefaces. Re-capture on a real Mac if parsing
// ever fails there (mac-plan §4.7).
const profilerFixture = JSON.stringify({
  SPFontsDataType: [
    {
      _name: 'Arial.ttf',
      path: '/System/Library/Fonts/Supplemental/Arial.ttf',
      typefaces: [
        { _name: 'Arial-Regular', family: 'Arial', style: 'Regular' },
        { _name: 'Arial-Bold', family: 'Arial', style: 'Bold' },
      ],
    },
    {
      _name: 'Avenir.ttc',
      path: '/System/Library/Fonts/Avenir.ttc',
      typefaces: [
        { _name: 'Avenir-Book', family: 'Avenir', style: 'Book' },
        { _name: 'AvenirNext-Regular', family: 'Avenir Next', style: 'Regular' },
      ],
    },
    { _name: 'Broken.ttf', path: '/Library/Fonts/Broken.ttf' },
  ],
})

describe('platform font discovery', () => {
  it('reads Unicode Windows families, single results, and failures', async () => {
    const windows = (stdout: string) => queryInstalledFontFamilies(async (file, args) => {
      expect(file).toBe('powershell.exe')
      expect(args.join(' ')).toContain('InstalledFontCollection')
      expect(args.join(' ')).toContain('UTF8Encoding')
      return { stdout }
    }, 'win32')
    expect(await windows('["Segoe UI","游ゴシック"]')).toEqual(['Segoe UI', '游ゴシック'])
    expect(await windows('"Segoe UI"')).toEqual(['Segoe UI'])
    expect(await windows('[]')).toEqual([])
    expect(await windows('not JSON')).toBeNull()
    expect(await windows('[12]')).toBeNull()
    expect(await queryInstalledFontFamilies(async () => { throw new Error('PowerShell unavailable') }, 'win32')).toBeNull()
  })
  it('parses fc-list output taking the canonical family per line', () => {
    expect(fontFamiliesFromFcList('Noto Sans,Noto Sans CJK\nAbel\nAbel\n\nZilla Slab')).toEqual([
      'Noto Sans',
      'Abel',
      'Zilla Slab',
    ])
  })

  it('parses system_profiler typeface families, ignoring entries without typefaces', () => {
    expect(fontFamiliesFromSystemProfiler(profilerFixture)).toEqual(['Arial', 'Avenir', 'Avenir Next'])
  })

  it('reports unrecognized system_profiler output as a failed query', () => {
    expect(fontFamiliesFromSystemProfiler('not json')).toBeNull()
    expect(fontFamiliesFromSystemProfiler('{"SPFontsDataType": 3}')).toBeNull()
  })

  it('queries the platform-native command and returns null on failure', async () => {
    const linux = await queryInstalledFontFamilies(async (file) => {
      expect(file).toBe('fc-list')
      return { stdout: 'Abel\n' }
    }, 'linux')
    expect(linux).toEqual(['Abel'])

    const darwin = await queryInstalledFontFamilies(async (file, args) => {
      expect(file).toBe('system_profiler')
      expect(args).toEqual(['-json', 'SPFontsDataType'])
      return { stdout: profilerFixture }
    }, 'darwin')
    expect(darwin).toEqual(['Arial', 'Avenir', 'Avenir Next'])

    expect(await queryInstalledFontFamilies(async () => { throw new Error('ENOENT') }, 'linux')).toBeNull()
    expect(await queryInstalledFontFamilies(async () => { throw new Error('ENOENT') }, 'darwin')).toBeNull()
  })
})
