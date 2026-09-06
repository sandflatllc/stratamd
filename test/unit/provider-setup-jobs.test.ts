import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ProviderSetupJobs } from '../../src/main/engine/provider-setup'
import type { AccountView } from '../../src/shared/contracts'

it('uses an existing tool without installation and cancels only its owned login process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-provider-job-'))
  const binary = join(root, 'provider')
  const jobs = new ProviderSetupJobs()
  let refreshed = 0, saved = 0
  try {
    await writeFile(binary, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); } process.stdout.write('Browser sign-in is waiting\\n'); setInterval(() => {}, 1000)\n`, { mode: 0o700 })
    const context = { executable: process.execPath, directory: root, baseDirectory: root }
    const account = { instanceId: 'work', driver: 'codex', name: 'Work' } as AccountView
    const settings = { providerInstances: { work: { driver: 'codex', config: { binaryPath: binary } } } }
    expect((await jobs.start('install', context, account, settings, join(root, 'install'), async () => { saved++ }, async () => { refreshed++ })).state).toBe('done')
    expect(refreshed).toBe(1); expect(saved).toBe(0)
    expect((await jobs.start('login', context, account, settings, join(root, 'install'), async () => undefined, async () => { refreshed++ })).state).toBe('running')
    await expect.poll(() => jobs.view('work').output).toContain('Browser sign-in is waiting')
    await expect(jobs.start('login', context, account, settings, root, async () => undefined, async () => undefined)).rejects.toThrow('Finish or cancel')
    await jobs.cancel()
    expect(jobs.view('work').state).toBe('cancelled'); expect(jobs.busy).toBe(false); expect(refreshed).toBe(1)
    await expect(jobs.start('install', context, account, { providerInstances: { work: { driver: 'codex', config: { binaryPath: join(root, 'missing') } } } }, root, async () => undefined, async () => undefined)).rejects.toThrow('bundled npm installer is missing')
    expect(jobs.busy).toBe(false)
  } finally { await jobs.cancel(); await rm(root, { recursive: true, force: true }) }
})
