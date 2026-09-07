#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, homedir, platform, release, arch } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest, filesIn, fingerprint, inputFiles, copyInputs, copyDependencies, validateLinks } from './inputs.mjs'
import { acquireLock } from './lock.mjs'
import { runProcess } from './process.mjs'
import { updateTask } from './records.mjs'

export async function verify(args, settings = {}) {
if (args.includes('--help')) {
  console.log(`Usage: node scripts/verify.mjs focused|full|stress|managed|packaged [options]
  --task NAME          Required task id; reuse across invocations to include gaps
  --unit FILE         Focused Vitest selector (repeatable)
  --e2e FILE[:LINE]    Focused Playwright selector (repeatable)
  --repeat N          Focused mechanism investigation repetitions (default 1)
  --reason TEXT       Required for repetitions; named suspected mechanism
  --bundle PATH       Managed mode: copy an already prepared stock bundle
  --reuse             Reuse a successful identical mode, coverage and input record
  --finish-task       Record the task verification result after this invocation

Focused always typechecks; Electron selection also builds. Full runs the ordinary
ordered gate. Stress runs all Electron projects twice. Managed prepares the pinned
bundle and runs managed integration/Electron checks. Packaged builds and tests the
host package. Linux Electron runs use xvfb-run. Evidence lives under
~/.cache/stratamd-verification/runs; STRATAMD_VERIFY_HOME can relocate evidence
but the machine lock always stays under ~/.cache/stratamd-verification.`)
  return
}
const mode = args.shift(), options = { unit: [], e2e: [], repeat: 1, reuse: false, finish: false }
if (!['focused', 'full', 'stress', 'managed', 'packaged'].includes(mode)) throw new Error('Choose focused, full, stress, managed or packaged; see --help')
while (args.length) {
  const option = args.shift()
  if (option === '--reuse') options.reuse = true
  else if (option === '--finish-task') options.finish = true
  else if (['--task', '--unit', '--e2e', '--repeat', '--reason', '--bundle'].includes(option)) {
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
    if (option === '--unit' || option === '--e2e') {
      if (value.startsWith('-') || value.includes('..') || !value.startsWith('test/')) throw new Error(`Use an explicit repository test path: ${value}`)
      options[option.slice(2)].push(value)
    } else options[option.slice(2)] = value
  } else throw new Error(`Unknown option ${option}`)
}
options.repeat = Number(options.repeat)
if (!options.task || !/^[a-zA-Z0-9_.-]+$/.test(options.task)) throw new Error('--task requires a simple stable name')
if (!Number.isSafeInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer')
if (mode !== 'focused' && (options.unit.length || options.e2e.length || options.repeat !== 1)) throw new Error('Selectors and --repeat require focused mode')
if (options.repeat > 1 && !options.e2e.length) throw new Error('--repeat requires Electron selectors; unit repetitions use the test framework directly')
if (options.repeat > 1 && !options.reason) throw new Error('Repetitions require --reason naming the suspected mechanism')
if (mode === 'focused' && !options.unit.length && !options.e2e.length) throw new Error('Focused mode requires explicit --unit or --e2e files')

if (options.bundle && mode !== 'managed') throw new Error('--bundle requires managed mode')

const started = Date.now(), id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const shared = settings.lockRoot ?? join(homedir(), '.cache/stratamd-verification')
const home = resolve(process.env.STRATAMD_VERIFY_HOME || shared), output = join(home, 'runs', id), candidate = join(output, 'candidate')
await mkdir(output, { recursive: true })
const controller = new AbortController()
const cancel = signal => controller.abort(new Error(`Cancelled by ${signal}`))
const onInt = () => cancel('SIGINT'), onTerm = () => cancel('SIGTERM')
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
const report = { schema: 1, id, mode, task: options.task, started: new Date(started).toISOString(), source: process.cwd(), output, options, status: 'running', stages: [], platform: { platform: platform(), release: release(), arch: arch(), node: process.version, host: hostname() } }
const persist = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await persist()
console.log(`Verification ${mode}: ${output}`)
let unlock, task, taskPath
async function timed(name, action, invocation) {
  const stage = { name, started: new Date().toISOString(), status: 'running', ...(invocation ? { invocation } : {}) }, before = Date.now()
  report.stages.push(stage); await persist()
  console.log(`${name} started`)
  try { const result = await action(); stage.status = 'passed'; return result }
  catch (error) { stage.status = 'failed'; throw error }
  finally { stage.durationMs = Date.now() - before; await persist(); console.log(`${name}: ${(stage.durationMs / 1000).toFixed(1)}s (${stage.status})`) }
}
try {
  unlock = await timed('queue', () => acquireLock(shared, { id, mode, source: process.cwd(), output }, controller.signal))
  await mkdir(join(home, 'tasks'), { recursive: true })
  taskPath = join(home, 'tasks', `${options.task}.json`)
  try { task = JSON.parse(await readFile(taskPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  task ??= { task: options.task, started: report.started, runs: [] }
  const root = await realpath(process.cwd()), dependencies = await realpath(join(root, 'node_modules'))
  const files = await inputFiles(root), dependencyFiles = await filesIn(dependencies)
  let dictionaries
  if (platform() === 'linux') {
    for (const path of [process.env.STRATAMD_SPELL_DICTIONARIES, join(homedir(), '.config/stratamd/Dictionaries'), join(homedir(), '.config/Electron/Dictionaries')].filter(Boolean)) {
      try {
        const names = (await readdir(path)).filter(name => name.endsWith('.bdic')).sort()
        if (names.length) { dictionaries = { path, files: names, fingerprint: await fingerprint(path, names) }; break }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  const bundle = options.bundle ? await realpath(options.bundle) : null
  const bundleFiles = bundle ? await filesIn(bundle) : []
  const identity = await timed('input identity', async () => ({ source: await fingerprint(root, files), dependencies: await fingerprint(dependencies, dependencyFiles), dictionaries: dictionaries?.fingerprint ?? null, bundle: bundle ? await fingerprint(bundle, bundleFiles) : null }))
  report.versions = Object.fromEntries(await Promise.all(['electron', '@playwright/test', 'vitest', 'typescript', 'electron-vite'].map(async name => {
    try { return [name, JSON.parse(await readFile(join(dependencies, name, 'package.json'), 'utf8')).version] }
    catch (error) { if (error.code === 'ENOENT') return [name, 'unavailable']; throw error }
  })))
  report.files = files
  report.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
  // Record hashes, never credentials. Conservative env matching includes unknown
  // variables; only invocation-specific shell/runner values are excluded.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PWD', 'OLDPWD', 'SHLVL', '_', 'STRATAMD_VERIFY_HOME'].includes(key)).sort().map(([key, value]) => [key, digest(value)]))
  const ordinary = platform() === 'darwin' ? 1 : mode === 'stress' ? (process.env.CI ? 2 : 8) : (process.env.CI ? 2 : 6)
  report.coverage = { mode, unit: options.unit, e2e: options.e2e, repetitions: mode === 'stress' ? 2 : options.repeat, ordinaryWorkers: ordinary, managedWorkers: 1, clipboardWorkers: 1, totalWorkers: platform() === 'darwin' ? 1 : ordinary + 1, retries: { unit: process.env.CI ? 1 : 0, electron: process.env.CI ? 2 : 0 } }
  report.environment = environment
  report.identity = { ...identity, platform: report.platform, environment, coverage: report.coverage }
  report.fingerprint = digest(JSON.stringify(report.identity))
  // Bundle/package preparation is external work and never reused implicitly.
  let reused
  if (options.reuse && !['managed', 'packaged'].includes(mode)) {
    for (const previous of (await readdir(join(home, 'runs'))).sort().reverse()) {
      if (previous === id) continue
      try {
        const record = JSON.parse(await readFile(join(home, 'runs', previous, 'report.json'), 'utf8'))
        if (record.status === 'passed' && !record.reusedFrom && record.fingerprint === report.fingerprint) {
          if (record.buildIdentity && await fingerprint(join(record.output, 'candidate/out'), await filesIn(join(record.output, 'candidate/out'))) !== record.buildIdentity) continue
          for (const [kind, file] of [['unit', 'unit.json'], ['electron', 'electron.json']]) if (record.results?.[kind]) await readFile(join(record.output, file))
          reused = record; break
        }
      } catch { /* Partial/missing records cannot satisfy the gate. */ }
    }
  }
  if (reused) {
    report.reusedFrom = reused.output; report.buildIdentity = reused.buildIdentity; report.results = reused.results
    console.log(`Reusing successful ${mode} coverage: ${reused.output}`)
  } else {
    await timed('stage candidate', async () => {
      await mkdir(candidate)
      await copyInputs(root, candidate, files)
      await copyDependencies(dependencies, join(candidate, 'node_modules'))
      if (dictionaries) {
        await copyInputs(dictionaries.path, join(candidate, 'build/dictionaries'), dictionaries.files)
        if (await fingerprint(join(candidate, 'build/dictionaries'), dictionaries.files) !== dictionaries.fingerprint) throw new Error('Dictionary inputs changed during staging')
      }
      if (bundle) {
        await validateLinks(bundle, bundleFiles)
        await cp(bundle, join(candidate, 'build/engine'), { recursive: true, verbatimSymlinks: true })
        if (await fingerprint(join(candidate, 'build/engine'), bundleFiles) !== identity.bundle) throw new Error('Bundle inputs changed during staging')
      }
      const copied = await fingerprint(candidate, files)
      const deps = await fingerprint(join(candidate, 'node_modules'), await filesIn(join(candidate, 'node_modules')))
      if (copied !== identity.source || deps !== identity.dependencies || await fingerprint(root, await inputFiles(root)) !== identity.source || await fingerprint(dependencies, await filesIn(dependencies)) !== identity.dependencies) throw new Error('Inputs changed while staging; candidate refused')
    })
    const env = { ...process.env, STRATAMD_E2E_WORKERS: String(ordinary), PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, 'electron.json'), STRATAMD_VERIFY_ELECTRON_TIMING: join(output, 'electron-timing.json'), STRATAMD_VERIFY_UNIT_RETRIES: join(output, 'unit-retries.json') }
    // An external bundle or test-output path would escape candidate isolation.
    for (const key of ['STRATAMD_E2E_ENGINE_BUNDLE', 'STRATAMD_ENGINE_BUNDLE', 'STRATAMD_PACKAGE_OUTPUT', 'STRATAMD_PACKAGED_TEST', 'STRATAMD_PACKAGED_ROOT', 'STRATAMD_E2E_DISPLAYS', 'PLAYWRIGHT_HTML_OUTPUT_DIR']) delete env[key]
    for (const key of Object.keys(env)) if (/CAPTURES/.test(key)) delete env[key]
    if (dictionaries) env.STRATAMD_SPELL_DICTIONARIES = join(candidate, 'build/dictionaries')
    const run = (name, command, argv) => timed(name, () => runProcess(command, argv, { cwd: candidate, env, log: join(output, `${name.replaceAll(' ', '-')}.log`), signal: controller.signal }), { command, args: argv })
    if (mode === 'full' || mode === 'focused') await run('typecheck', './node_modules/.bin/tsc', ['--noEmit'])
    if (mode === 'full' || options.unit.length) await run('unit integration', './node_modules/.bin/vitest', ['run', ...options.unit, '--reporter=default', '--reporter=json', '--reporter=./scripts/verification/unit-reporter.mjs', `--outputFile=${join(output, 'unit.json')}`])
    if (mode === 'managed') {
      if (!bundle) await run('bundle preparation', process.execPath, ['scripts/stage-engine.mjs'])
      report.bundleIdentity = await fingerprint(join(candidate, 'build/engine'), await filesIn(join(candidate, 'build/engine')))
      env.STRATAMD_E2E_ENGINE_BUNDLE = join(candidate, 'build/engine')
      env.STRATAMD_ENGINE_BUNDLE = join(candidate, 'build/engine')
      await run('unit integration', './node_modules/.bin/vitest', ['run', 'test/integration/managed-engine.test.ts', 'test/integration/managed-attachments.test.ts', 'test/integration/managed-connections.test.ts', 'test/integration/managed-settings.test.ts', 'test/integration/engine-upgrade.test.ts', '--reporter=default', '--reporter=json', '--reporter=./scripts/verification/unit-reporter.mjs', `--outputFile=${join(output, 'unit.json')}`])
    }
    if (mode === 'packaged') {
      await run('package preparation', process.execPath, ['scripts/build-packaged.mjs', join(output, 'package')])
      report.buildIdentity = await fingerprint(join(candidate, 'out'), await filesIn(join(candidate, 'out')))
      report.bundleIdentity = await fingerprint(join(candidate, 'build/engine'), await filesIn(join(candidate, 'build/engine')))
      report.packageIdentity = await fingerprint(join(output, 'package'), await filesIn(join(output, 'package')))
      env.STRATAMD_PACKAGED_TEST = '1'
      await run('unit integration', './node_modules/.bin/vitest', ['run', 'test/integration/packaged-cli.test.ts', '--reporter=default', '--reporter=json', '--reporter=./scripts/verification/unit-reporter.mjs', `--outputFile=${join(output, 'unit.json')}`])
    }
    if (['full', 'stress', 'managed'].includes(mode) || options.e2e.length) {
      await run('build', './node_modules/.bin/electron-vite', ['build'])
      report.buildIdentity = await fingerprint(join(candidate, 'out'), await filesIn(join(candidate, 'out')))
      const argv = ['test', ...options.e2e, '--reporter=list,json,./scripts/verification/electron-reporter.cjs', `--output=${join(output, 'test-results')}`, `--repeat-each=${report.coverage.repetitions}`, ...(mode === 'managed' ? ['--project=managed'] : [])]
      await run('electron setup execution cleanup', platform() === 'linux' ? 'xvfb-run' : './node_modules/.bin/playwright', platform() === 'linux' ? ['-a', './node_modules/.bin/playwright', ...argv] : argv)
    }
    await timed('integrity', async () => {
      if (await fingerprint(candidate, files) !== identity.source || await fingerprint(join(candidate, 'node_modules'), await filesIn(join(candidate, 'node_modules'))) !== identity.dependencies) throw new Error('Candidate inputs changed during verification; result contaminated')
      if (report.buildIdentity && await fingerprint(join(candidate, 'out'), await filesIn(join(candidate, 'out'))) !== report.buildIdentity) throw new Error('Build output changed during verification; result contaminated')
      if (report.bundleIdentity && await fingerprint(join(candidate, 'build/engine'), await filesIn(join(candidate, 'build/engine'))) !== report.bundleIdentity) throw new Error('Engine bundle changed during verification; result contaminated')
      if (report.packageIdentity && await fingerprint(join(output, 'package'), await filesIn(join(output, 'package'))) !== report.packageIdentity) throw new Error('Package changed during verification; result contaminated')
    })
  }
  report.status = 'passed'
} catch (error) {
  report.status = controller.signal.aborted ? 'interrupted' : 'failed'
  report.error = error.stack ?? String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  try {
  // Parse even failed runs so skipped/retried outcomes remain visible.
  report.results ??= {}
  for (const [kind, file] of [['unit', 'unit.json'], ['electron', 'electron.json']]) {
    try {
      const result = JSON.parse(await readFile(join(output, file), 'utf8'))
      if (kind === 'unit') report.results.unit = { passed: result.numPassedTests, failed: result.numFailedTests, tests: result.testResults.flatMap(suite => suite.assertionResults.map(test => ({ file: suite.name, title: test.fullName, status: test.status, durationMs: test.duration }))), skipped: result.testResults.flatMap(suite => suite.assertionResults.filter(test => ['pending', 'todo', 'skipped'].includes(test.status)).map(test => ({ file: suite.name, title: test.fullName }))) }
      else {
        const tests = []
        const visit = suites => { for (const suite of suites) { for (const spec of suite.specs ?? []) for (const test of spec.tests) tests.push({ file: spec.file, line: spec.line, title: spec.title, project: test.projectName, status: test.status, attempts: test.results.map(result => ({ status: result.status, durationMs: result.duration, retry: result.retry })) }); visit(suite.suites ?? []) } }
        visit(result.suites); report.results.electron = { stats: result.stats, tests, skipped: tests.filter(test => test.status === 'skipped'), flaky: tests.filter(test => test.status === 'flaky') }
        if (report.status === 'passed' && report.results.electron.flaky.length) { report.status = 'flaky'; process.exitCode = 1 }
      }
    } catch (error) { if (error.code !== 'ENOENT' || (report.status === 'passed' && !report.reusedFrom && report.stages.some(stage => stage.name === (kind === 'unit' ? 'unit integration' : 'electron setup execution cleanup')))) { report.reportError = String(error); report.status = 'failed'; process.exitCode = 1 } }
  }
  try {
    const retried = JSON.parse(await readFile(join(output, 'unit-retries.json'), 'utf8'))
    report.results.unit.retried = retried
    if (report.status === 'passed' && retried.length) { report.status = 'flaky'; process.exitCode = 1 }
  } catch (error) { if (error.code !== 'ENOENT') { report.status = 'failed'; report.reportError = String(error); process.exitCode = 1 } }
  try {
    const timing = JSON.parse(await readFile(join(output, 'electron-timing.json'), 'utf8'))
    const stage = report.stages.find(stage => stage.name === 'electron setup execution cleanup')
    if (timing.firstTest && timing.lastTest && stage) report.electronTiming = {
      setupMs: timing.firstTest - Date.parse(stage.started),
      executionMs: timing.lastTest - timing.firstTest,
      cleanupMs: Date.parse(stage.started) + stage.durationMs - timing.lastTest,
      boundary: 'command start / first test start / last test end / command close'
    }
  } catch (error) { if (error.code !== 'ENOENT') { report.status = 'failed'; report.reportError = String(error); process.exitCode = 1 } }
  if (report.status === 'passed' && ['managed', 'packaged'].includes(mode) && ((report.results.unit?.skipped.length ?? 0) || (report.results.electron?.skipped.length ?? 0))) {
    report.status = 'failed'; report.reportError = 'Explicit runtime coverage skipped required tests'; process.exitCode = 1
  }
  const cleanupStarted = Date.now()
  // Retain source/build and all failure artifacts; dependency copies are disposable.
  await rm(join(candidate, 'node_modules'), { recursive: true, force: true }).catch(error => { report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1 })
  report.stages.push({ name: 'cleanup', durationMs: Date.now() - cleanupStarted, status: report.cleanupError ? 'failed' : 'passed' })
  report.finished = new Date().toISOString(); report.commandDurationMs = Date.now() - started
  if (task) {
    updateTask(task, report, options.finish)
    report.taskDurationMs = task.elapsedMs
    await writeFile(taskPath, JSON.stringify(task, null, 2) + '\n')
  }
  await persist()
  const summary = `${mode}: ${report.status}. Command ${(report.commandDurationMs / 1000).toFixed(1)}s; task ${((report.taskDurationMs ?? report.commandDurationMs) / 1000).toFixed(1)}s. Skipped: ${report.results.unit?.skipped.length ?? 0} unit/integration, ${report.results.electron?.skipped.length ?? 0} Electron.\nEvidence: ${output}\n`
  await writeFile(join(output, 'summary.txt'), summary)
  console.log(summary)
  } finally {
    await unlock?.()
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
  }
}

}
