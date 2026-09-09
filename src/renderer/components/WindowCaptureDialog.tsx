import { useEffect, useRef, useState } from 'react'
import type { EngineView } from '../../shared/contracts'
import type { CapturedWindow, CaptureSource, CaptureStatus } from '../../shared/window-capture'
import { SetupDialog } from './SetupDialog'
export function WindowCaptureDialog({ engine, enabled: initialEnabled, onClose, onCapture }: {
  engine: EngineView; enabled: boolean; onClose(): void
  onCapture(capture: CapturedWindow, target: { projectId: string; threadId: string; threadTitle: string }): void
}) {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [identity] = useState(engine.identity ?? null)
  const [enabled, setEnabled] = useState(initialEnabled)
  const [status, setStatus] = useState<CaptureStatus | null>(null)
  const [shortcut, setShortcut] = useState(false)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [selected, setSelected] = useState('')
  const [target, setTarget] = useState(engine.activeThreadId ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const targets = engine.projects.flatMap(project => project.threads.map(thread => ({ projectId: project.id, threadId: thread.id, threadTitle: thread.title })))
  useEffect(() => { void window.strata.windowCapture({ action: 'status' }).then(result => { if ('status' in result) { setStatus(result.status); setShortcut(result.status.shortcut !== 'disabled') } }).catch(error => setError(String(error))) }, [])
  const permission = status && ['denied', 'restricted'].includes(status.screenPermission)
  const run = async () => {
    setBusy(true); setError('')
    try {
      if (!sources) {
        const result = await window.strata.windowCapture({ action: 'choose' })
        if (!alive.current) return
        if ('sources' in result) { setSources(result.sources); setSelected(result.sources[0]?.token ?? ''); if (!result.sources.length) setError('Capture cancelled. Choose a window when you are ready.') }
      } else {
        const destination = targets.find(row => row.threadId === target)
        if (!destination) throw new Error('Choose a conversation for this capture.')
        const result = await window.strata.windowCapture({ action: 'capture', token: selected, projectId: destination.projectId, threadId: destination.threadId, engine: identity })
        if ('capture' in result) { if (alive.current) onCapture(result.capture, destination); else await window.strata.discardConversationAttachment(result.capture.id) }
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setSources(null) }
    finally { setBusy(false) }
  }
  return <SetupDialog title="Window capture" subtitle="Capture one window and hold it for your next message." onClose={onClose} className="window-capture-dialog" footer={<><button className="quiet-button" disabled={busy} onClick={onClose}>Cancel</button>{permission ? <button className="primary-button" onClick={() => void window.strata.windowCapture({ action: 'screen-settings' })}>Open System Settings</button> : <button className="primary-button" disabled={busy || !enabled || !target || (sources !== null && !selected)} onClick={() => void run()}>{busy ? 'Waiting for capture…' : sources ? 'Review capture' : 'Capture a window'}</button>}</>}>
    {permission ? <><h3>Allow screen recording on your Mac</h3><p>In System Settings, open Privacy &amp; Security → Screen Recording and enable Strata.</p><p>You may need to restart Strata after changing this permission.</p><p>Accessibility is optional. It adds readable text from supported apps.</p><button className="quiet-button" onClick={() => void window.strata.windowCapture({ action: 'accessibility-settings' })}>Open Accessibility settings</button></> : sources ? <><h3>{status?.picker === 'system' ? 'Choose a window in the system picker' : 'Choose a window'}</h3><p>{status?.picker === 'system' ? 'Your system picker controls what Strata can capture. Choose a window there, then review the selected image below.' : 'Choose the window you want to review and mark up.'}</p><div className="capture-sources">{sources.map(source => <button key={source.token} className="capture-source" aria-pressed={selected === source.token} onClick={() => setSelected(source.token)}><img src={source.thumbnail} alt=""/><span>{source.name}<small>{status?.picker === 'system' ? 'System selection' : 'Selected window'} · {targets.find(row => row.threadId === target)?.threadTitle}</small></span></button>)}</div><button className="quiet-button" onClick={() => setSources(null)}>Choose another window</button></> : <><label className="capture-enable capture-settings-row"><input type="checkbox" aria-label="Enable window capture" checked={enabled} disabled={busy} onChange={event => { const next = event.target.checked; setEnabled(next); setBusy(true); void window.strata.updateSettings({ windowCapture: { enabled: next, shortcut: false } }).catch(error => { setEnabled(!next); setError(String(error)) }).finally(() => setBusy(false)) }} /><span>Enable window capture<small>Choose a window each time. Review the capture before sending.</small></span></label><label className="capture-destination capture-settings-row"><strong>Hold captures for</strong><select aria-label="Hold captures for" value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose a conversation</option>{targets.map(row => <option key={row.threadId} value={row.threadId}>{row.threadTitle}</option>)}</select></label><label className="capture-shortcut"><input type="checkbox" checked={shortcut} disabled={!enabled} onChange={event => { const next = event.target.checked; void window.strata.updateSettings({ windowCapture: { enabled, shortcut: next } }).then(async () => { setShortcut(next); const result = await window.strata.windowCapture({ action: 'status' }); if ('status' in result) setStatus(result.status) }).catch(error => setError(String(error))) }} />Use {status?.platform === 'darwin' ? '⌘' : 'Ctrl'}+Shift+5. {status?.shortcut === 'conflict' ? 'This shortcut is in use or unavailable. Use Capture a window instead.' : 'The system picker opens when you capture.'}</label>{status?.platform === 'darwin' && !status.accessibilityPermission && <p>Accessibility is optional. <button className="text-action" onClick={() => void window.strata.windowCapture({ action: 'accessibility-settings' })}>Open Accessibility settings</button> to include readable text from supported apps.</p>}</>}
    {error && <p role="alert">{error}</p>}
  </SetupDialog>
}
