import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// macOS hands out TMPDIR under /var, a symlink to /private/var. The engine
// keys sessions and ghost entries by realpath, so fixtures built from a raw
// os.tmpdir() would name the same file by a second spelling and miss every
// lookup. Canonicalizing TMPDIR once makes every tmpdir() caller consistent;
// a no-op on Linux.
process.env.TMPDIR = realpathSync(tmpdir())
if (process.platform === 'win32') process.env.TEMP = process.env.TMPDIR

// Anything that derives a location from the environment (the failure log,
// the default ghost store) lands in a per-file scratch directory
// instead of the developer's real ~/.local/share, ~/.config, or runtime dir.
// Tests that need a specific environment still pass it explicitly.
const scratch = mkdtempSync(join(process.env.TMPDIR, 'stratamd-test-env-'))
process.env.XDG_DATA_HOME = join(scratch, 'data')
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_RUNTIME_DIR = join(scratch, 'runtime')

// Only vitest has a suite to hang the cleanup on; any other importer (a
// Playwright harness canonicalizing TMPDIR) must not touch vitest's hooks.
if (process.env.VITEST) {
  const { afterAll } = await import('vitest')
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })
}
