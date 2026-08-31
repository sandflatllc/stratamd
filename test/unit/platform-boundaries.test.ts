import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(fileURLToPath(import.meta.url), '../../../src')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('platform source boundaries', () => {
  it('keeps process.platform checks inside src/platform', async () => {
    // Behavior that differs by platform belongs in the small src/platform
    // modules (mac-plan §3); feature code must not grow its own checks.
    const offenders: string[] = []
    for (const file of await sourceFiles(sourceRoot)) {
      const path = relative(sourceRoot, file)
      if (path.startsWith('platform/')) continue
      const content = await readFile(file, 'utf8')
      if (content.includes('process.platform')) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })

  it('keeps Electron imports out of platform, CLI, shared, and renderer code', async () => {
    // src/platform stays loadable by the CLI; shared and renderer code must
    // never reach main-process APIs (mac-plan §3 boundaries).
    const offenders: string[] = []
    for (const file of await sourceFiles(sourceRoot)) {
      const path = relative(sourceRoot, file)
      if (!/^(?:platform|cli|shared|renderer|editor|core)\//.test(path)) continue
      const content = await readFile(file, 'utf8')
      if (/from 'electron'|import\('electron'\)|require\('electron'\)/.test(content)) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
