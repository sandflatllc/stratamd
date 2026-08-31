import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

// macOS hands out TMPDIR under /var, a symlink to /private/var. The engine
// keys sessions and ghost entries by realpath, so fixtures built from a raw
// os.tmpdir() would name the same file by a second spelling and miss every
// lookup. Canonicalizing TMPDIR once makes every tmpdir() caller consistent;
// a no-op on Linux.
process.env.TMPDIR = realpathSync(tmpdir())
