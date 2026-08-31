import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDirectory, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from './storage.js'

// Local failure record (docs/plans/completed/crash-hardening-plan.md §5): warnings and errors
// only, one JSON line each, written synchronously so rotation cannot race a
// pending write and a fatal-path record lands before the process exits.
// Nothing here may ever throw into a caller.

const MESSAGE_CAP = 2_000
const STACK_CAP = 4_000
const ROTATE_BYTES = 2 * 1024 * 1024

export interface LogRecord {
  time: string
  level: 'warn' | 'error'
  scope: string
  message: string
  name?: string
  frame?: string
  componentStack?: string
}

const cap = (value: string, limit: number): string => (value.length > limit ? `${value.slice(0, limit)}…` : value)

/** The first stack frame below the `Error: message` line — the actionable one. */
export function firstFrame(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  for (const line of stack.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('at ')) return cap(trimmed, 500)
  }
  return undefined
}

export class LogFile {
  readonly #directory: string
  readonly #path: string
  #prepared = false

  constructor(directory: string) {
    this.#directory = directory
    this.#path = join(directory, 'stratamd.log')
  }

  get path(): string {
    return this.#path
  }

  write(record: LogRecord): void {
    try {
      if (!this.#prepared) {
        mkdirSync(this.#directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
        this.#prepared = true
      }
      try {
        if (statSync(this.#path).size >= ROTATE_BYTES) renameSync(this.#path, `${this.#path}.1`)
      } catch {
        // Missing file: nothing to rotate.
      }
      appendFileSync(this.#path, `${JSON.stringify(record)}\n`, { mode: PRIVATE_FILE_MODE })
    } catch {
      // A failing log must never become a second failure.
    }
  }
}

export function makeRecord(
  level: 'warn' | 'error',
  scope: string,
  message: string,
  error?: unknown,
  componentStack?: string,
): LogRecord {
  const record: LogRecord = {
    time: new Date().toISOString(),
    level,
    scope: cap(scope, 100),
    message: cap(message, MESSAGE_CAP),
  }
  if (error instanceof Error) {
    record.name = cap(error.name, 100)
    if (record.message !== cap(error.message, MESSAGE_CAP) && error.message) {
      record.message = cap(`${message}: ${error.message}`, MESSAGE_CAP)
    }
    const frame = firstFrame(error.stack)
    if (frame) record.frame = frame
  } else if (error !== undefined) {
    record.message = cap(`${message}: ${String(error)}`, MESSAGE_CAP)
  }
  if (componentStack) record.componentStack = cap(componentStack, STACK_CAP)
  return record
}

let defaultLog: LogFile | null = null

function log(): LogFile {
  if (!defaultLog) defaultLog = new LogFile(join(getDataDirectory(), 'logs'))
  return defaultLog
}

export function logWarn(scope: string, message: string): void {
  log().write(makeRecord('warn', scope, message))
}

export function logError(scope: string, message: string, error?: unknown, componentStack?: string): void {
  log().write(makeRecord('error', scope, message, error, componentStack))
}

/** A structured renderer report arriving over IPC; the stack is already a string. */
export function logRendererReport(report: { scope: string; message: string; stack?: string | undefined; componentStack?: string | undefined }): void {
  const record = makeRecord('error', report.scope, report.message, undefined, report.componentStack)
  const frame = firstFrame(report.stack)
  if (frame) record.frame = frame
  log().write(record)
}
