import { z } from 'zod'
export const accessScopes = ['orchestration:read', 'orchestration:operate', 'terminal:operate', 'review:write', 'access:read', 'access:write', 'relay:read', 'relay:write'] as const
export const computerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'progress']) }).strict(),
  z.object({ action: z.literal('login'), method: z.enum(['browser', 'code']).optional() }).strict(),
  z.object({ action: z.enum(['logout', 'change-account', 'cancel', 'use-code']) }).strict(),
  z.object({ action: z.literal('input'), text: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('download'), accepted: z.boolean() }).strict(),
  z.object({ action: z.literal('configure'), remote: z.boolean(), publish: z.boolean() }).strict(),
  z.object({ action: z.literal('preferences'), keepRunning: z.boolean(), startAtLogin: z.boolean() }).strict(),
  z.object({ action: z.literal('network'), lan: z.boolean(), tailscale: z.boolean(), port: z.number().int().min(1).max(65535) }).strict(),
  z.object({ action: z.literal('create-link'), label: z.string().trim().max(200), scopes: z.array(z.enum(accessScopes)).min(1).max(8) }).strict(),
  z.object({ action: z.enum(['revoke-link', 'revoke-device']), id: z.string().min(1).max(512) }).strict(),
])
export type ComputerRequest = z.infer<typeof computerRequest>
export const connectStatus = z.object({ desired: z.boolean(), authenticated: z.boolean(), linked: z.boolean(), cloudUserId: z.string().nullable(), publishAgentActivity: z.boolean(), relayClient: z.object({ status: z.string(), version: z.string().optional() }) })
export type ConnectStatus = z.infer<typeof connectStatus>
export type ConnectPhase = 'authorizing' | 'browser' | 'code' | 'download' | 'installing' | 'applying' | 'restarting'
export interface ConnectJob { state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'; message: string; phase?: ConnectPhase; url?: string }
export interface ComputerView {
  connect: ConnectStatus | null
  account: string | null
  remoteEnabled: boolean | null
  connectionState: 'signed-out' | 'off' | 'starting' | 'configured' | 'device-connected' | 'failed' | 'unavailable'
  connectionMessage: string
  tailscaleStatus: string
  job: ConnectJob
  preferences: { keepRunning: boolean; startAtLogin: boolean; lan: boolean; tailscale: boolean; port: number }
  environmentName: string
  endpoints: string[]
  links: { id: string; label?: string; expiresAt: string; scopes: string[] }[]
  devices: { sessionId: string; label: string; current: boolean; connected: boolean }[]
  problems: string[]
  createdLink?: { credential: string; expiresAt: string }
}
export const connectionChoices = z.object({ linked: z.boolean(), cloudUserId: z.string().nullable(), managedTunnelActive: z.boolean().optional(), publishAgentActivity: z.boolean() })
export function preferredPairingEndpoint(endpoints: string[]): string {
  return endpoints.find(url => !isLoopbackEndpoint(url)) ?? endpoints[0] ?? ''
}
export function isLoopbackEndpoint(endpoint: string): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname) } catch { return true }
}
