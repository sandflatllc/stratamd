import { test, expect } from './test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stockSnapshotEncoder } from '../fixtures/stock-preview-schema'
import { Scenario } from './harness'
const execute = promisify(execFile)

test('background guests preserve fresh captures and state without covering the composed desktop', async ({}, testInfo) => {
  test.skip(process.platform !== 'linux', 'Native desktop capture uses X11; macOS composition remains a release check')
  const scenario = await Scenario.create(testInfo, '# Composition probe')
  try {
    const bundle = join(scenario.root, 'composition.mjs')
    const { build } = createRequire(realpathSync('node_modules/vite/package.json'))('esbuild')
    await build({ entryPoints: [resolve('test/fixtures/preview-composition.ts')], outfile: bundle, platform: 'node', format: 'esm', bundle: true, external: ['electron'] })
    const electron = createRequire(import.meta.url)('electron') as string
    try {
      const { stdout, stderr } = await execute(electron, ['--ozone-platform=x11', bundle], { env: { ...scenario.env, STRATA_COMPOSITION_OUTPUT: scenario.root }, timeout: 25000 })
      await writeFile(join(scenario.root, 'process.log'), stdout + stderr)
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string }
      await writeFile(join(scenario.root, 'process.log'), (output.stdout ?? '') + (output.stderr ?? ''))
      throw error
    }
    const report = JSON.parse(await readFile(join(scenario.root, 'report.json'), 'utf8'))
    expect(report.states).toHaveLength(10)
    if (process.env.STRATAMD_ENGINE_BUNDLE) {
      const encode = await stockSnapshotEncoder(process.env.STRATAMD_ENGINE_BUNDLE, scenario.root)
      const snapshot = JSON.parse(await readFile(join(scenario.root, 'snapshot.json'), 'utf8')).result
      expect(() => encode(snapshot)).not.toThrow()
      expect(() => encode({ ...snapshot, loading: true })).not.toThrow()
      expect(() => encode({ ...snapshot, loading: undefined })).toThrow()
    }
    expect(report.states.every((state: { shellVisible: boolean; pageVisible: boolean; freshCapture: boolean; formAndScrollKept: boolean }) => state.shellVisible && state.pageVisible && state.freshCapture && state.formAndScrollKept)).toBe(true)
  } finally {
    try {
      for (const name of await readdir(scenario.root)) {
        if (name.endsWith('.png') || name.endsWith('.log') || name === 'report.json') await testInfo.attach(name, { path: join(scenario.root, name) })
      }
    } finally { await scenario.dispose() }
  }
})
