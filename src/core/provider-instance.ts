/** Instance naming and supported configuration fields from t3's provider settings. */
export function deriveInstanceId(driver: string, label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  return slug ? `${driver}_${slug}` : ''
}
export function validProviderInstanceId(id: string): boolean { return id.length <= 64 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) }
export function providerConfigFields(driver: string): Array<{ key: string; label: string }> {
  return [
    { key: 'binaryPath', label: 'Binary path' },
    ...(['codex', 'claudeAgent'].includes(driver) ? [{ key: 'homePath', label: 'Account home path' }] : []),
    ...(driver === 'codex' ? [{ key: 'shadowHomePath', label: 'Shadow home path' }] : []),
    ...(['codex', 'claudeAgent'].includes(driver) ? [{ key: 'launchArgs', label: 'Launch arguments' }] : []),
    ...(driver === 'claudeAgent' ? [{ key: 'autoCompactWindow', label: 'Auto-compact after' }] : []),
    ...(driver === 'cursor' ? [{ key: 'apiEndpoint', label: 'API endpoint' }] : []),
    ...(driver === 'opencode' ? [{ key: 'serverUrl', label: 'Server URL' }, { key: 'serverPassword', label: 'Server password' }] : []),
  ]
}
