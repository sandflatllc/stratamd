// Runs under the bundled Node, outside Electron and app.asar. Only normalized readings leave this process.
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const measuredAt = new Date().toISOString()
const window = (percent, reset) => typeof percent === 'number' && Number.isFinite(percent) ? { usedPercent: percent, resetsAt: typeof reset === 'string' ? reset : null, measuredAt } : null
let result = null
let child
let query
const timer = setTimeout(() => { child?.kill('SIGTERM'); query?.close(); process.exit(2) }, 30000)
try {
  if (request.driver === 'codex') {
    child = spawn(request.binary, ['app-server'], { cwd: request.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    let sequence = 0, buffer = ''
    const pending = new Map()
    child.on('error', error => { for (const { reject } of pending.values()) reject(error) })
    child.on('exit', () => { for (const { reject } of pending.values()) reject(new Error('Provider exited')) })
    child.stdout.on('data', bytes => {
      buffer += bytes
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try { const value = JSON.parse(line); const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); value.error ? waiter.reject(new Error('Provider query failed')) : waiter.resolve(value.result) } } catch { /* Non-protocol output is never forwarded. */ }
      }
    })
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n') })
    await rpc('initialize', { clientInfo: { name: 'strata_usage', version: '0.1.0' } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    const account = (await rpc('account/read', { refreshToken: false })).account
    if (request.email && account?.email && request.email.toLowerCase() !== account.email.toLowerCase()) throw new Error('Account identity changed')
    const limits = await rpc('account/rateLimits/read', {})
    const rate = limits.rateLimits ?? limits.rateLimitsByLimitId?.codex
    const windows = [rate?.primary, rate?.secondary].filter(Boolean)
    const session = windows.find(value => value.windowDurationMins > 0 && value.windowDurationMins <= 1440)
    const weekly = windows.find(value => value.windowDurationMins >= 10080 && value.windowDurationMins < 43200)
    const normalize = value => value ? window(value.usedPercent, typeof value.resetsAt === 'number' ? new Date(value.resetsAt * 1000).toISOString() : null) : null
    if (session || weekly) result = { session: normalize(session), weekly: normalize(weekly), planLabel: account?.planType ?? rate?.planType, applicable: true, measuredAt }
  } else if (request.driver === 'claudeAgent') {
    const sdk = await import(pathToFileURL(request.sdk).href)
    let release
    query = sdk.query({ prompt: { async *[Symbol.asyncIterator]() { await new Promise(resolve => { release = resolve }) } }, options: { cwd: request.cwd, persistSession: false, settingSources: [], tools: [], pathToClaudeCodeExecutable: request.binary } })
    try {
      if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') throw new Error('Usage query unavailable')
      if (request.email && typeof query.accountInfo === 'function') {
        const account = await query.accountInfo()
        if (account?.email && request.email.toLowerCase() !== account.email.toLowerCase()) throw new Error('Account identity changed')
      }
      const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      if (usage.rate_limits_available) result = { session: window(usage.rate_limits?.five_hour?.utilization, usage.rate_limits?.five_hour?.resets_at), weekly: window(usage.rate_limits?.seven_day?.utilization, usage.rate_limits?.seven_day?.resets_at), planLabel: usage.subscription_type, applicable: true, measuredAt }
    } finally { query.close(); release?.() }
  }
  process.stdout.write(JSON.stringify(result) + '\n')
} catch { process.stdout.write('null\n') } finally { clearTimeout(timer); child?.kill('SIGTERM'); query?.close() }
