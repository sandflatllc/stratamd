/**
 * Installed font family discovery: fc-list on Linux, system_profiler on macOS
 * (docs/plans/open/mac-plan.md §4.7). Family names come from font metadata on
 * both platforms, never from filenames — collections and styled files make
 * filename guessing inaccurate. A null result means the query failed or its
 * output was not recognized; callers fall back to the bundled families.
 */
export type FontCommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>

export function fontFamiliesFromFcList(output: string): string[] {
  const families = new Set<string>()
  for (const line of output.split('\n')) {
    // fc-list separates localized family names with commas; the first is canonical.
    const family = line.split(',')[0]?.trim()
    if (family) families.add(family)
  }
  return [...families]
}

interface ProfilerTypeface {
  readonly family?: unknown
}

interface ProfilerFont {
  readonly typefaces?: readonly ProfilerTypeface[]
}

export function fontFamiliesFromSystemProfiler(output: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  const fonts = (parsed as { SPFontsDataType?: unknown })?.SPFontsDataType
  if (!Array.isArray(fonts)) return null
  const families = new Set<string>()
  for (const font of fonts as ProfilerFont[]) {
    if (!Array.isArray(font?.typefaces)) continue
    for (const typeface of font.typefaces) {
      if (typeof typeface?.family === 'string' && typeface.family.trim()) {
        families.add(typeface.family.trim())
      }
    }
  }
  return [...families]
}

export async function queryInstalledFontFamilies(
  run: FontCommandRunner,
  platform: string = process.platform,
): Promise<string[] | null> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await run('system_profiler', ['-json', 'SPFontsDataType'])
      return fontFamiliesFromSystemProfiler(stdout)
    }
    const { stdout } = await run('fc-list', ['--format', '%{family}\n'])
    return fontFamiliesFromFcList(stdout)
  } catch {
    return null
  }
}
