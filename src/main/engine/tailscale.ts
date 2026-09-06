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
