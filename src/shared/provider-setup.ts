import { z } from 'zod'
export const providerSetupRequest = z.object({ identity: z.string().nullable(), instanceId: z.string().min(1), action: z.enum(['install', 'login', 'cancel', 'input', 'status']), input: z.string().max(4096).optional() }).strict()
export type ProviderSetupRequest = z.infer<typeof providerSetupRequest>
export interface ProviderSetupView { instanceId: string; state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'; message: string; output: string }
