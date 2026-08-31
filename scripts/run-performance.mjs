import { spawn } from 'node:child_process'

const playwrightArguments = ['exec', 'playwright', 'test', '-c', 'playwright.performance.config.ts', ...process.argv.slice(2)]
const hasXDisplay = Boolean(process.env.DISPLAY)
const executable = hasXDisplay ? 'pnpm' : 'xvfb-run'
const arguments_ = hasXDisplay ? playwrightArguments : ['-a', 'pnpm', ...playwrightArguments]
const child = spawn(executable, arguments_, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    STRATAMD_PERF_DISPLAY_MODE: hasXDisplay ? 'desktop' : 'xvfb',
  },
  stdio: 'inherit',
})

child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
