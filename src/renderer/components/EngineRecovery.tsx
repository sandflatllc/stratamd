import { useEffect, useState } from 'react'
import type { RecoveryRequest, RecoveryView } from '../../shared/engine-recovery'
export function EngineRecovery() {
  const [view, setView] = useState<RecoveryView | null>(null)
  const [selected, setSelected] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = async (request: RecoveryRequest) => {
    setBusy(true); setError('')
    try { const next = await window.strata.engineRecovery?.(request); if (next) setView(next); if (request.action === 'restore') { setSelected(''); setAcknowledged(false) } } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  useEffect(() => { void request({ action: 'status' }) }, [])
  const backup = view?.backups.find(row => row.id === selected)
  return <details><summary>Engine updates and recovery</summary>
    <p>Running {view?.currentVersion ?? 'unknown'}. Bundled {view?.bundledVersion ?? 'unknown'}.</p>
    {view?.currentVersion !== view?.bundledVersion && <button className="quiet-button" disabled={busy} onClick={() => void request({ action: 'update' })}>Use bundled engine</button>}
    <p>Updates wait for active work and queued deliveries. Backups include engine history and document conversation links.</p>
    <label>Engine backup<select aria-label="Engine backup" value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setAcknowledged(false) }}><option value="">Choose a backup</option>{view?.backups.map(row => <option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString()} · {row.version} · {row.kind}</option>)}</select></label>
    {backup && <><p>Restore engine history from {new Date(backup.createdAt).toLocaleString()}. Newer conversations will leave the active history and be kept in a separate backup. Markdown files, review history and unsent text stay as they are. Project files and worktrees are not rewound.</p><label className="settings-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />Keep newer work in a backup and restore this engine history</label><button className="quiet-button" disabled={busy || !acknowledged} onClick={() => void request({ action: 'restore', backupId: backup.id, acknowledgeNewerWork: true })}>Restore engine backup</button></>}
    {busy && <p role="status">Checking and preserving engine data…</p>}
    {view?.message && <p role="status">{view.message}</p>}
    {error && <p role="alert">{error}</p>}
  </details>
}
