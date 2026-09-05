import { spawn, type ChildProcess } from 'node:child_process'
import type { FullConfig } from '@playwright/test'

/**
 * One X display per Playwright worker (docs/plans/open/e2e-test-setup-2026-09-05-plan.md §2a).
 *
 * Every Electron launch calls `window.focus()`. On one X display without a
 * window manager that takes focus from every other Electron window, and the
 * renderer closes its menus on `blur`; the X clipboard is per display too.
 * Global setup starts one Xvfb per worker slot and publishes the list in
 * STRATAMD_E2E_DISPLAYS; the harness assigns each test the display for its
 * `parallelIndex`, so at most one app window exists on any display.
 */

export const DISPLAYS_VARIABLE = 'STRATAMD_E2E_DISPLAYS'
export const SERIAL_COMMAND = 'xvfb-run -a ./node_modules/.bin/playwright test --workers 1'

const SCREEN = '2560x1600x24'
const READY_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 2_000

/** Parses the published list; undefined when the variable is unset or empty. */
export function parseDisplays(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const displays = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  const invalid = displays.find((entry) => !/^:\d+(\.\d+)?$/.test(entry))
  if (invalid !== undefined) {
    throw new Error(`${DISPLAYS_VARIABLE} holds ${JSON.stringify(invalid)}; each entry must be an X display such as :99`)
  }
  return displays
}

interface XvfbServer {
  display: string
  process: ChildProcess
}

/** Starts one Xvfb and resolves once it has written its display number to fd 3. */
function startXvfb(): Promise<XvfbServer> {
  return new Promise((resolve, reject) => {
    const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', SCREEN, '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    let settled = false
    let buffered = ''
    const finish = (outcome: { display: string } | { error: Error }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if ('display' in outcome) {
        resolve({ display: outcome.display, process: child })
      } else {
        child.kill('SIGTERM')
        reject(outcome.error)
      }
    }
    const timer = setTimeout(() => {
      finish({ error: new Error(`Xvfb did not report a display within ${READY_TIMEOUT_MS} ms${stderr ? `: ${stderr.trim()}` : ''}`) })
    }, READY_TIMEOUT_MS)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      finish({ error: new Error(`Could not start Xvfb: ${error.message}`) })
    })
    child.once('exit', (code, signal) => {
      finish({ error: new Error(`Xvfb exited before it was ready (${signal ?? `code ${code}`})${stderr ? `: ${stderr.trim()}` : ''}`) })
    })
    const ready = child.stdio[3]
    if (!ready || typeof (ready as NodeJS.ReadableStream).on !== 'function') {
      finish({ error: new Error('Xvfb -displayfd pipe was not created') })
      return
    }
    ;(ready as NodeJS.ReadableStream).setEncoding('utf8')
    ;(ready as NodeJS.ReadableStream).on('data', (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      const number = buffered.slice(0, newline).trim()
      if (!/^\d+$/.test(number)) {
        finish({ error: new Error(`Xvfb reported an unexpected display ${JSON.stringify(number)}`) })
        return
      }
      finish({ display: `:${number}` })
    })
  })
}

async function stopXvfb(server: XvfbServer): Promise<void> {
  const child = server.process
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop() }, STOP_TIMEOUT_MS)
    child.once('exit', () => { clearTimeout(timer); resolveStop() })
    child.kill('SIGTERM')
  })
}

export default async function globalSetup(config: FullConfig): Promise<(() => Promise<void>) | undefined> {
  if (process.platform === 'darwin') return undefined

  const supplied = parseDisplays(process.env[DISPLAYS_VARIABLE])
  if (supplied) {
    if (supplied.length < config.workers) {
      throw new Error(
        `${DISPLAYS_VARIABLE} lists ${supplied.length} display(s) but the run has ${config.workers} workers; ` +
        `supply at least one display per worker, unset it so the suite starts its own, or run ${SERIAL_COMMAND}`
      )
    }
    return undefined
  }

  // A serial run has one window at a time and keeps the caller's display, so
  // the serial escape hatch works even where Xvfb cannot start.
  if (config.workers <= 1) return undefined

  const servers: XvfbServer[] = []
  try {
    for (let slot = 0; slot < config.workers; slot += 1) {
      servers.push(await startXvfb())
    }
  } catch (error) {
    await Promise.all(servers.map(stopXvfb))
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not start an X display per worker (${message}). Run serially instead: ${SERIAL_COMMAND}`)
  }
  // Workers start after global setup, so they inherit this value.
  process.env[DISPLAYS_VARIABLE] = servers.map((server) => server.display).join(',')

  return async () => {
    await Promise.all(servers.map(stopXvfb))
  }
}
