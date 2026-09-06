import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory } from '../storage'

/** A managed environment has a stable identity even when its listening port changes. */
export function connectionIdentity(server: string, environmentId?: string): string {
  return createHash('sha256').update(environmentId ? `environment:${environmentId}` : `origin:${new URL(server).origin}`).digest('hex').slice(0, 32)
}

export const ENGINE_STORE_FILES = ['engine-credential.json', 'engine-reading.json', 'engine-commands.json', 'engine-accounts.json', 'engine-conversations.json'] as const

/** The original connection keeps the original files. Every later connection gets a private directory. */
export async function connectionDirectory(root: string, identity: string): Promise<string> {
  const marker = join(root, 'engine-identity.json')
  let original: string | undefined
  try { original = JSON.parse(await readFile(marker, 'utf8')).identity } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!original) {
    await ensurePrivateDirectory(root)
    await atomicWriteFile(marker, JSON.stringify({ identity }))
    return root
  }
  const directory = original === identity ? root : join(root, 'engine-connections', identity)
  await ensurePrivateDirectory(directory)
  return directory
}
