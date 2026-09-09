import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'strata-verify-fixture-')); roots.push(root)
  const source = join(root, 'source'), home = join(root, 'home')
  await mkdir(source); await mkdir(home)
  execFileSync('git', ['init', '-q'], { cwd: source })
  await mkdir(join(source, 'scripts'), { recursive: true })
  await cp(resolve('scripts/tool-command.mjs'), join(source, 'scripts/tool-command.mjs'))
  await cp(resolve('scripts/verify.mjs'), join(source, 'scripts/verify.mjs'))
  await cp(resolve('scripts/verification'), join(source, 'scripts/verification'), { recursive: true })
  await writeFile(join(source, 'scripts/verify-fixture.mjs'), `import { verify } from './verification/run.mjs'; await verify(process.argv.slice(2), { lockRoot: ${JSON.stringify(join(home, 'locks'))}, electronStallMs: process.env.FIXTURE_ELECTRON_STALL_MS ? Number(process.env.FIXTURE_ELECTRON_STALL_MS) : undefined });`)
  await mkdir(join(source, 'native/unix-support/build/Release'), { recursive: true })
  await writeFile(join(source, 'native/unix-support/build/Release/unix_support.node'), 'fixture')
  await writeFile(join(source, '.gitignore'), 'node_modules/\nnative/unix-support/build/\nout/\n')
  await writeFile(join(source, 'input.txt'), 'original')
  await mkdir(join(source, 'node_modules/.bin'), { recursive: true })
  const binary = `#!${process.execPath}
const fs = require('node:fs');
if (process.env.FIXTURE_WAIT) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], {detached:true,stdio:'ignore'}); child.unref(); fs.writeFileSync(process.env.FIXTURE_WAIT + '.child', String(child.pid)); fs.writeFileSync(process.env.FIXTURE_WAIT, process.cwd()); setInterval(() => {}, 1000); }
else if (process.argv.includes('--noEmit')) {}
else if (process.argv.includes('build')) { fs.mkdirSync('out'); fs.writeFileSync('out/index.js', 'build'); }
else if (process.argv[1].endsWith('playwright')) {
  if (process.env.FIXTURE_ELECTRON_STALL) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {detached:true,stdio:'ignore'});
    child.unref(); fs.writeFileSync(process.env.FIXTURE_ELECTRON_STALL + '.child', String(child.pid));
    fs.writeFileSync(process.env.STRATAMD_VERIFY_ELECTRON_PROGRESS, JSON.stringify({event:'test-begin'}));
    process.stdout.write('fixture electron started\\n'); setInterval(() => {}, 1000);
  } else fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({stats:{expected:1,unexpected:0,skipped:0,flaky:0},suites:[]}));
}
else { const out = process.argv.find(a => a.startsWith('--outputFile=')); if (out) fs.writeFileSync(out.slice(13), JSON.stringify({numPassedTests: 1, numFailedTests: 0, testResults: [{name:'fixture', assertionResults:[{status:'pending',fullName:'intentional skip'}]}]})); }
`
  for (const name of ['tsc', 'vitest', 'electron-vite', 'playwright']) await writeFile(join(source, 'node_modules/.bin', name), binary, { mode: 0o755 })
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: source })
  function run(extra: string[] = [], env: Record<string, string> = {}, mode = 'focused') {
    const child = spawn(process.execPath, ['scripts/verify-fixture.mjs', mode, '--task', 'fixture', ...(mode === 'focused' ? ['--unit', 'test/unit/fixture.test.ts'] : []), ...extra], { cwd: source, env: { ...process.env, STRATAMD_VERIFY_HOME: join(home, 'evidence'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = ''
    child.stdout!.on('data', data => { output += data }); child.stderr!.on('data', data => { output += data })
    const done = new Promise<number | null>(resolve => child.on('exit', resolve))
    return { child, done, output: () => output }
  }
  async function reports() {
    const directory = join(home, 'evidence/runs')
    return Promise.all((await readdir(directory)).sort().map(async name => JSON.parse(await readFile(join(directory, name, 'report.json'), 'utf8'))))
  }
  return { source, root, run, reports }
}

it('isolates edits and builds, retains artifacts, and cancels ownership before the waiter proceeds', async () => {
  const f = await fixture(), marker = join(f.root, 'started')
  const first = f.run([], { FIXTURE_WAIT: marker })
  await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).not.toBe('')
  const candidate = await readFile(marker, 'utf8')
  await writeFile(join(f.source, 'input.txt'), 'changed by owner')
  await mkdir(join(f.source, 'out')); await writeFile(join(f.source, 'out/index.js'), 'owner rebuild')
  expect(await readFile(join(candidate, 'input.txt'), 'utf8')).toBe('original')
  const second = f.run()
  await expect.poll(second.output).toContain('Waiting')
  expect(second.output()).toContain('requested focused')
  first.child.kill('SIGTERM')
  expect(await first.done).toBe(1)
  const ownedChild = (await readFile(marker + '.child', 'utf8')).trim()
  await expect.poll(() => {
    try { return execFileSync('ps', ['-o', 'stat=', '-p', ownedChild], { encoding: 'utf8' }).trim().startsWith('Z') }
    catch { return true }
  }).toBe(true)
  expect(await second.done, second.output()).toBe(0)
  const reports = await f.reports()
  expect(reports.map(report => report.status)).toEqual(['interrupted', 'passed'])
  expect(await readFile(join(reports[0].output, 'typecheck.log'), 'utf8')).toContain(`Process cleanup captured descendants: ${ownedChild}`)
  expect(await readFile(join(reports[0].output, 'candidate/input.txt'), 'utf8')).toBe('original')
  expect(reports[1].results.unit.skipped[0].title).toBe('intentional skip')
}, 20_000)

it('reuses identical successful inputs across commits and invalidates source, untracked and dependency changes', async () => {
  const f = await fixture()
  const first = f.run(); expect(await first.done, first.output()).toBe(0)
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'same inputs'], { cwd: f.source })
  const reused = f.run(['--reuse']); expect(await reused.done, reused.output()).toBe(0)
  expect((await f.reports()).at(-1).reusedFrom).toBeTruthy()
  for (const [name, content] of [['input.txt', 'edit'], ['new-test.txt', 'untracked'], ['node_modules/identity', 'changed dependency']]) {
    await writeFile(join(f.source, name!), content!)
    const changed = f.run(['--reuse']); expect(await changed.done, changed.output()).toBe(0)
    expect((await f.reports()).at(-1).reusedFrom).toBeUndefined()
  }
  const record = (await f.reports()).at(-1)
  expect(record.taskDurationMs).toBeGreaterThan(record.commandDurationMs)
  expect(record.coverage.mode).toBe('focused')
}, 20_000)

it('refuses changed candidate files and never reuses failed evidence', async () => {
  const f = await fixture()
  const binary = join(f.source, 'node_modules/.bin/tsc')
  await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync('input.txt', 'contaminated')\n`, { mode: 0o755 })
  const contaminated = f.run()
  expect(await contaminated.done, contaminated.output()).toBe(1)
  expect((await f.reports()).at(-1).error).toContain('Candidate inputs changed during verification; result contaminated. Source: input.txt')
  const again = f.run(['--reuse'])
  expect(await again.done, again.output()).toBe(1)
  expect((await f.reports()).at(-1).reusedFrom).toBeUndefined()
  expect(await readFile(join(f.source, 'input.txt'), 'utf8')).toBe('original')
}, 20_000)

it('a focused pass cannot replace the full ordered gate or its stress coverage', async () => {
  const f = await fixture()
  const focused = f.run(); expect(await focused.done, focused.output()).toBe(0)
  const full = f.run(['--reuse'], {}, 'full'); expect(await full.done, full.output()).toBe(0)
  const report = (await f.reports()).at(-1)
  expect(report.reusedFrom).toBeUndefined()
  expect(report.stages.filter((stage: { name: string }) => ['typecheck', 'unit integration', 'build', 'electron setup execution cleanup'].includes(stage.name)).map((stage: { name: string }) => stage.name)).toEqual(['typecheck', 'unit integration', 'build', 'electron setup execution cleanup'])
  const stress = f.run(['--reuse'], {}, 'stress'); expect(await stress.done, stress.output()).toBe(0)
  expect((await f.reports()).at(-1)).toMatchObject({ coverage: { mode: 'stress', repetitions: 2, ordinaryWorkers: process.platform === 'darwin' ? 1 : process.env.CI ? 2 : 8, clipboardWorkers: 1, managedWorkers: 1 } })
  expect((await f.reports()).at(-1).reusedFrom).toBeUndefined()
}, 20_000)

it('streams CI Electron progress and stops an owned stalled process tree', async () => {
  const f = await fixture(), marker = join(f.root, 'electron-stall')
  const stalled = f.run(['--e2e', 'test/e2e/fixture.spec.ts'], { CI: 'true', FIXTURE_ELECTRON_STALL: marker, FIXTURE_ELECTRON_STALL_MS: '5000' })
  expect(await stalled.done, stalled.output()).toBe(1)
  expect(stalled.output()).toContain('fixture electron started')
  expect(stalled.output()).toContain('made no test-event progress')
  const report = (await f.reports()).at(-1)
  const electron = report.stages.find((stage: { name: string }) => stage.name === 'electron setup execution cleanup')
  expect(electron.invocation.args).toContain('--max-failures=3')
  expect(report.status).toBe('failed')
  expect(report.error).toContain('made no test-event progress')
  const electronLog = await readFile(join(report.output, 'electron-setup-execution-cleanup.log'), 'utf8')
  expect(electronLog).toContain('fixture electron started')
  const ownedChild = (await readFile(marker + '.child', 'utf8')).trim()
  expect(electronLog).toContain(`Process cleanup captured descendants:`)
  expect(electronLog).toContain(ownedChild)
  await expect.poll(() => {
    try { return execFileSync('ps', ['-o', 'stat=', '-p', ownedChild], { encoding: 'utf8' }).trim().startsWith('Z') }
    catch { return true }
  }).toBe(true)
}, 20_000)
