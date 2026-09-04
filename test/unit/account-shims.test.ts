import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTerminalShims } from '../../src/main/account-shims'

describe('account terminal shims', () => {
  it('writes an owner-only launcher with the selected account home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-shims-'))
    const [path] = await writeTerminalShims(root, [{ name: 'codex-work', command: 'codex', home: '/accounts/work' }])
    expect(await readFile(path!, 'utf8')).toContain('CODEX_HOME="/accounts/work" "codex" "$@"')
    expect((await stat(path!)).mode & 0o777).toBe(0o700)
  })
})
