import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Retain the PTY's loadable modules and runtime helpers, never compiler outputs. */
export async function pruneNativeBuild(directory) {
  try {
    for (const entry of await readdir(directory)) if (entry !== 'Release') await rm(join(directory, entry), { recursive: true, force: true })
    const release = join(directory, 'Release')
    for (const entry of await readdir(release)) {
      if (entry === 'conpty') {
        for (const file of await readdir(join(release, entry))) if (!['conpty.dll', 'OpenConsole.exe'].includes(file)) await rm(join(release, entry, file), { recursive: true, force: true })
      } else if (!/\.(node|dll|exe)$/i.test(entry) && entry !== 'spawn-helper') await rm(join(release, entry), { recursive: true, force: true })
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
