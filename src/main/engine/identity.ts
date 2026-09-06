import { z } from 'zod'

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

export async function readEngineIdentity(fetch: typeof globalThis.fetch, server: string, timeoutMs = 3_000): Promise<EngineIdentity> {
  const response = await fetch(`${server}${ENGINE_ENVIRONMENT_PATH}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`The engine did not describe itself (${response.status})`)
  const parsed = descriptor.safeParse(await response.json())
  if (!parsed.success) throw new Error('The engine described itself in a form Strata cannot read')
  return { environmentId: parsed.data.environmentId, label: parsed.data.label ?? null }
}
