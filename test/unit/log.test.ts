import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstFrame, LogFile, makeRecord } from '../../src/main/log.js'

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'stratamd-log-')), 'logs')

describe('the failure log', () => {
  it('writes one valid JSON line per record into a private directory', () => {
    const file = new LogFile(scratch())
    file.write(makeRecord('warn', 'watcher', 'fell behind'))
    file.write(makeRecord('error', 'renderer', 'boom', new Error('bad state')))

    const lines = readFileSync(file.path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(first).toMatchObject({ level: 'warn', scope: 'watcher', message: 'fell behind' })
    expect(second).toMatchObject({ level: 'error', scope: 'renderer', message: 'boom: bad state', name: 'Error' })
    expect(statSync(file.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(file.path, '..')).mode & 0o777).toBe(0o700)
  })

  it('keeps a multi-line message and stack on a single line', () => {
    const file = new LogFile(scratch())
    const error = new Error('line one\nline two')
    file.write(makeRecord('error', 'main', 'multi\nline', error, 'at Pane\nat App'))
    const lines = readFileSync(file.path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!) as { message: string; componentStack: string }
    expect(record.message).toContain('line two')
    expect(record.componentStack).toBe('at Pane\nat App')
  })

  it('caps oversized fields instead of bloating the file', () => {
    const record = makeRecord('error', 'x'.repeat(500), 'y'.repeat(50_000), undefined, 'z'.repeat(50_000))
    expect(record.scope.length).toBeLessThanOrEqual(101)
    expect(record.message.length).toBeLessThanOrEqual(2_001)
    expect(record.componentStack!.length).toBeLessThanOrEqual(4_001)
  })

  it('extracts the first actionable frame, not the Error line', () => {
    const stack = 'RangeError: Position 9547 outside of fragment\n    at Fragment.findIndex (app://x/index.js:12853:13)\n    at Node.nodeAt (app://x/index.js:13795:53)'
    expect(firstFrame(stack)).toBe('at Fragment.findIndex (app://x/index.js:12853:13)')
    expect(firstFrame(undefined)).toBeUndefined()
    expect(firstFrame('no frames here')).toBeUndefined()
  })

  it('rotates once at the cap and keeps writing', () => {
    const directory = scratch()
    const file = new LogFile(directory)
    file.write(makeRecord('warn', 'seed', 'create the file'))
    writeFileSync(file.path, 'x'.repeat(2 * 1024 * 1024))
    file.write(makeRecord('warn', 'after', 'first post-rotation record'))
    const current = readFileSync(file.path, 'utf8').trimEnd().split('\n')
    expect(current).toHaveLength(1)
    expect((JSON.parse(current[0]!) as { scope: string }).scope).toBe('after')
    expect(statSync(`${file.path}.1`).size).toBeGreaterThanOrEqual(2 * 1024 * 1024)
  })

  it('never throws even when the directory cannot be created', () => {
    const locked = mkdtempSync(join(tmpdir(), 'stratamd-log-locked-'))
    chmodSync(locked, 0o500)
    const file = new LogFile(join(locked, 'logs'))
    expect(() => file.write(makeRecord('error', 'main', 'goes nowhere'))).not.toThrow()
    chmodSync(locked, 0o700)
  })
})
