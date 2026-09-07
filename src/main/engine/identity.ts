import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, ensurePrivateDirectory } from '../storage'

/** A managed environment has a stable identity even when its listening port changes. */
export function connectionIdentity(server: string, environmentId?: string): string {
  return createHash('sha256').update(environmentId ? `environment:${environmentId}` : `origin:${new URL(server).origin}`).digest('hex').slice(0, 32)
}

export const ENGINE_STORE_FILES = ['engine-credential.json', 'engine-reading.json', 'engine-commands.json', 'engine-accounts.json', 'engine-conversations.json', 'engine-visual-comments.json'] as const

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

/**
 * The engine's identity (docs/plans/open/visual-review, phase 2). T3 names
 * each server by an environment id; registering as its browser host needs
 * that id, and Strata's contract does not carry it anywhere else. This is the
 * one place it is read, from the descriptor T3 publishes beside its API.
 */
export const ENGINE_ENVIRONMENT_PATH = '/.well-known/t3/environment'

const descriptor = z.object({ environmentId: z.string().trim().min(1), label: z.string().optional() }).passthrough()

export interface EngineIdentity {
  environmentId: string
  label: string | null
}

export async function readEngineIdentity(fetch: typeof globalThis.fetch, server: string, timeoutMs = 3_000, accessToken?: string): Promise<EngineIdentity> {
  const response = await fetch(`${server}${ENGINE_ENVIRONMENT_PATH}`, { signal: AbortSignal.timeout(timeoutMs), ...(accessToken ? { headers: { authorization: `Bearer ${accessToken}` } } : {}) })
  if (!response.ok) throw new Error(`The engine did not describe itself (${response.status})`)
  const parsed = descriptor.safeParse(await response.json())
  if (!parsed.success) throw new Error('The engine described itself in a form Strata cannot read')
  return { environmentId: parsed.data.environmentId, label: parsed.data.label ?? null }
}
