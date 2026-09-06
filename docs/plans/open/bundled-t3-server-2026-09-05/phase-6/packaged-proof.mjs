import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const evidence = import.meta.dirname
const profile = await mkdtemp(join(tmpdir(), 'strata-packaged-clean-'))
for (const path of ['home', 'config', 'data', 'cache', 'run', 'empty-bin']) await mkdir(join(profile, path), { mode: 0o700 })
await symlink('/bin/sh', join(profile, 'empty-bin/sh'))
const document = join(profile, 'proof.md')
await writeFile(document, '# Bundled engine on a fresh profile\n\nDocuments keep working.\n')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(STRATAMD_|T3CODE_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|VITEST)/.test(key)))
Object.assign(env, { HOME: join(profile, 'home'), XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'), XDG_CACHE_HOME: join(profile, 'cache'), XDG_RUNTIME_DIR: join(profile, 'run'), STRATAMD_USER_DATA: join(profile, 'electron'), CODEX_HOME: join(profile, 'home/codex'), CLAUDE_CONFIG_DIR: join(profile, 'home/claude'), PATH: join(profile, 'empty-bin') })
let application, record
try {
  application = await electron.launch({ executablePath: resolve('dist/linux-unpacked/stratamd-app'), args: ['--no-sandbox', document], env })
  const page = await application.firstWindow()
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.managed?.state, { timeout: 45000 }).toBe('running')
  await page.evaluate(() => window.strata.refreshAccounts())
  const state = await page.evaluate(() => window.strata.getState())
  record = JSON.parse(await readFile(join(profile, 'data/stratamd/engine/runtime.json'), 'utf8'))
  if (!record.executable.startsWith(join(profile, 'data/stratamd/engine/runtime'))) throw new Error('Engine did not use its staged runtime')
  await page.getByRole('button', { name: 'Engine status' }).click()
  await expect(page.getByRole('dialog', { name: 'This computer' })).toBeVisible()
  await expect(page.getByText('Signed out of T3', { exact: true })).toBeVisible()
  await expect(page.locator('.toast').filter({ hasText: 'Error invoking remote method' })).toHaveCount(0)
  await page.screenshot({ path: join(evidence, 'packaged-this-computer.png') })
  await page.getByRole('dialog', { name: 'This computer' }).getByRole('button', { name: 'Accounts', exact: true }).click()
  const installed = []
  for (const driver of ['codex', 'claudeAgent']) {
    const account = (await page.evaluate(() => window.strata.getState())).engine.accounts.find(row => row.driver === driver)
    if (!account) throw new Error(`Missing ${driver} account`)
    const region = page.getByLabel(`Set up ${account.name}`, { exact: true })
    const repair = region.getByRole('button', { name: `Check or install ${account.name}`, exact: true })
    const install = region.getByRole('button', { name: `Install ${account.name}`, exact: true })
    await (await repair.count() ? repair : install).click()
    let job
    await expect.poll(async () => { job = await page.evaluate(({ identity, instanceId }) => window.strata.providerSetup({ identity, instanceId, action: 'status' }), { identity: state.engine.identity, instanceId: account.instanceId }); return ['done', 'failed', 'cancelled'].includes(job.state) }, { timeout: 120000 }).toBe(true)
    if (job.state !== 'done') throw new Error(`${driver} installation ${job.state}: ${job.message} ${job.output}`)
    const settings = await page.evaluate(() => window.strata.readEngineSettings())
    const binary = settings.providerInstances[account.instanceId]?.config?.binaryPath
    if (typeof binary !== 'string' || !binary.startsWith(join(profile, 'data/stratamd/engine/providers'))) throw new Error(`Provider ${driver} was not installed in the isolated Strata directory`)
    installed.push({ driver, binary })
  }
  const proof = { result: 'passed', platform: process.platform, architecture: process.arch, freshHome: true, systemNodeOnPath: false, engineState: state.engine.state, runtimeVersion: record.version, nodeVersion: record.nodeVersion, stagedExecutable: record.executable, isolatedBaseDirectory: record.baseDirectory, accounts: state.engine.accounts.map(account => ({ driver: account.driver, installed: account.installed, usable: account.usable, state: account.state })), documentOpened: !!state.activeDocument, hostedLoginAttempted: false, managedProviderInstalls: installed }
  await application.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await expect.poll(async () => { try { process.kill(record.pid, 0); return true } catch { return false } }, { timeout: 15000 }).toBe(false)
  await writeFile(join(evidence, 'packaged-proof.json'), JSON.stringify({ ...proof, ownedEngineStoppedOnQuit: true }, null, 2) + '\n')
} catch (error) { if (application) { const page = await application.firstWindow(); const state = await page.evaluate(() => window.strata.getState()).catch(() => null); await writeFile(join(evidence, 'packaged-failure.json'), JSON.stringify(state?.engine.managed ?? null, null, 2)); await page.screenshot({ path: join(evidence, 'packaged-failure.png') }).catch(() => undefined) } throw error } finally { await application?.close().catch(() => undefined); if (record) { try { const args = (await readFile(`/proc/${record.pid}/cmdline`, 'utf8')).split('\0'); if (args[args.indexOf('--base-dir') + 1] === record.baseDirectory && await realpath(`/proc/${record.pid}/exe`) === await realpath(record.executable)) process.kill(record.pid, 'SIGTERM') } catch {} } await rm(profile, { recursive: true, force: true }) }
