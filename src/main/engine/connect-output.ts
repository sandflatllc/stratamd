import type { ConnectPhase } from '../../shared/computer'

/** The stock CLI is an interactive protocol. Only recognized, safe messages reach the renderer. */
export function readConnectOutput(output: string): { phase?: ConnectPhase; message?: string; url?: string; account?: string; cancelled: boolean } {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const urls = [...clean.matchAll(/https:\/\/app\.t3\.codes\/connect[^\s\x1b]*(?=\s)/g)]
  const candidate = urls.at(-1)?.[0]
  let url: string | undefined
  if (candidate) { try { const parsed = new URL(candidate); if (parsed.origin === 'https://app.t3.codes' && parsed.pathname === '/connect') url = parsed.href } catch { /* A split output chunk is incomplete. */ } }
  const account = clean.match(/(?:Signed in|Authorized) as ([^\r\n]+)/)?.[1]?.trim()
  const cancelled = /setup cancelled|relay client was not installed/i.test(clean)
  const phase = /Authorization code[^\n]*$/.test(clean.trimEnd()) ? 'code' : /Relay client:.*(?:Checking|Waiting|Downloading|Verifying|Installing|Validating|Activating)/i.test(clean) ? 'installing' : /Download and install version[^\n]*\?/.test(clean) && !/Relay client ready/.test(clean) ? 'download' : url ? 'browser' : undefined
  const messages = { code: 'Paste the authorization code from your browser.', browser: 'Finish signing in in your browser. Strata will continue automatically.', download: 'T3 needs connection support to make this computer available remotely.', installing: 'Installing connection support…' }
  return { cancelled, ...(phase ? { phase, message: messages[phase] } : {}), ...(url ? { url } : {}), ...(account ? { account: account.slice(0, 200) } : {}) }
}
export function connectFailure(output: string): string {
  if (/environment_link_limit_exceeded|managed tunnel limit/i.test(output)) return 'Your T3 account has reached its computer limit. Remove an unused computer in T3 Connect, then retry setup.'
  if (/auth_invalid|invalid_bearer|unauthorized|credential.*revoked/i.test(output)) return 'T3 rejected this account authorization. Reconnect your account, then retry setup.'
  if (/expired|invalid.*code|state.*mismatch|authorization.*invalid/i.test(output)) return 'This authorization code is invalid or expired. Start sign-in again for a fresh code.'
  if (/EADDRINUSE|address already in use/i.test(output)) return 'The browser callback is already in use. Retry sign-in with the pasted-code option.'
  if (/ENOTFOUND|ECONN|fetch failed|network|HTTP.*(?:408|429|5\d\d)/i.test(output)) return 'T3 could not connect. Check your internet connection and retry.'
  if (/unsupported/i.test(output)) return 'T3 connection support is unavailable for this computer. Use private-network pairing or update Strata.'
  return 'T3 setup could not finish. Retry, or reconnect your account if authorization has expired.'
}
