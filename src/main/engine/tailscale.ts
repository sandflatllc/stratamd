import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
let cached: { time: number; promise: Promise<string> } | null = null
export async function readTailscale(): Promise<string> {
  if (cached && Date.now() - cached.time < 30000) return cached.promise
  const promise = (async () => {
    try {
      const result = await promisify(execFile)('tailscale', ['status', '--json'], { timeout: 3000, maxBuffer: 64000 })
      const status = JSON.parse(result.stdout)
      return status.BackendState === 'Running' ? `Tailscale is running${typeof status.Self?.DNSName === 'string' ? ` as ${status.Self.DNSName.replace(/\.$/, '')}` : ''}.` : 'Start Tailscale and sign in before enabling HTTPS.'
    } catch { return 'Install Tailscale and sign in before enabling HTTPS.' }
  })()
  cached = { time: Date.now(), promise }; return promise
}

/** An address is usable only when Serve's HTTPS root proxies to this exact engine. */
export function verifiedServeEndpoint(status: any, serve: any, server: string, port: number): string | null {
  const name = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : ''
  if (status?.BackendState !== 'Running' || !/^[a-z0-9.-]+$/i.test(name) || serve?.TCP?.[String(port)]?.HTTPS !== true) return null
  const proxy = serve?.Web?.[`${name}:${port}`]?.Handlers?.['/']?.Proxy
  if (typeof proxy !== 'string') return null
  try {
    const expected = new URL(server), target = new URL(proxy)
    const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'loopback' : host
    if (target.protocol !== expected.protocol || local(target.hostname) !== local(expected.hostname) || target.port !== expected.port || target.pathname !== '/' || target.search || target.hash || target.username || target.password) return null
    return `https://${name}${port === 443 ? '' : `:${port}`}`
  } catch { return null }
}
export async function readServeEndpoint(server: string, port: number): Promise<string | null> {
  try {
    const run = promisify(execFile)
    const [status, serve] = await Promise.all([run('tailscale', ['status', '--json'], { timeout: 3000, maxBuffer: 64000 }), run('tailscale', ['serve', 'status', '--json'], { timeout: 3000, maxBuffer: 64000 })])
    return verifiedServeEndpoint(JSON.parse(status.stdout), JSON.parse(serve.stdout), server, port)
  } catch { return null }
}
