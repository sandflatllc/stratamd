import { z } from 'zod'
export const accessScopes = ['orchestration:read', 'orchestration:operate', 'terminal:operate', 'review:write', 'access:read', 'access:write', 'relay:read', 'relay:write'] as const
export const computerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'progress']) }).strict(),
  z.object({ action: z.enum(['login', 'logout', 'cancel']) }).strict(),
  z.object({ action: z.literal('input'), text: z.string().max(4096) }).strict(),
  z.object({ action: z.enum(['remote', 'publish']), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('preferences'), keepRunning: z.boolean(), startAtLogin: z.boolean() }).strict(),
  z.object({ action: z.literal('network'), lan: z.boolean(), tailscale: z.boolean(), port: z.number().int().min(1).max(65535) }).strict(),
  z.object({ action: z.literal('create-link'), label: z.string().trim().max(200), scopes: z.array(z.enum(accessScopes)).min(1).max(8) }).strict(),
  z.object({ action: z.enum(['revoke-link', 'revoke-device']), id: z.string().min(1).max(512) }).strict(),
])
export type ComputerRequest = z.infer<typeof computerRequest>
export const connectStatus = z.object({ desired: z.boolean(), authenticated: z.boolean(), linked: z.boolean(), cloudUserId: z.string().nullable(), publishAgentActivity: z.boolean(), relayClient: z.object({ status: z.string(), version: z.string().optional() }) })
export type ConnectStatus = z.infer<typeof connectStatus>
export interface ConnectJob { state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'; message: string; output: string; url?: string }
export interface ComputerView {
  connect: ConnectStatus | null
  remoteEnabled: boolean | null
  tailscaleStatus: string
  job: ConnectJob
  preferences: { keepRunning: boolean; startAtLogin: boolean; lan: boolean; tailscale: boolean; port: number }
  environmentName: string
  endpoints: string[]
  links: { id: string; label?: string; expiresAt: string; scopes: string[] }[]
  devices: { sessionId: string; label: string; current: boolean; connected: boolean }[]
  createdLink?: { credential: string; expiresAt: string }
  problems: string[]
}
