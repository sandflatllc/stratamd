import { useEffect, useState } from 'react'
import type { BrowserEvidenceView } from '../../shared/browser-evidence'
import './browser-evidence.css'

export function BrowserEvidence({ evidence, onOpen }: { evidence: BrowserEvidenceView; onOpen(evidence: BrowserEvidenceView, url: string): void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const image = evidence.mimeType === 'image/png'
  useEffect(() => {
    let active = true
    if (image) void window.strata.previewEvidenceAction(evidence.id, 'open').then(value => { if (active) setUrl(value) }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [evidence.id, image])
  const show = async () => {
    try { setError(''); const source = await window.strata.previewEvidenceAction(evidence.id, 'open'); if (source) onOpen(evidence, source) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  return <section className="browser-evidence" aria-label={image ? 'Screenshot evidence' : 'Recording evidence'} data-evidence-state={evidence.status}>
    {image && url && <img className="browser-evidence-thumbnail" src={url} alt="Saved browser screenshot" />}
    <div className="browser-evidence-copy"><strong>{evidence.name}</strong>
      <small>{evidence.status === 'transferring' ? 'Copying to the agent environment' : evidence.status === 'failed' ? 'Could not copy to the agent environment' : evidence.uploadedAttachmentId ? 'Saved locally and copied to the agent environment' : 'Saved locally'} · {(evidence.sizeBytes / 1024).toFixed(1)} KB</small>
      {evidence.status === 'transferring' && <progress aria-label="Evidence transfer" />}
      {evidence.destination && evidence.status !== 'saved' && <small>Destination: {evidence.destination}</small>}
      {evidence.status === 'failed' && <small>{evidence.error} The saved copy is still on this computer.</small>}
      <div><button type="button" onClick={() => void show()}>{image ? 'Open screenshot' : 'View completed copy'}</button>{evidence.status === 'failed' && evidence.destination && <button type="button" onClick={() => { setError(''); void window.strata.previewEvidenceAction(evidence.id, 'retry').catch(reason => setError(String(reason))) }}>Retry copy</button>}</div>
      {error && <small role="alert">{error}</small>}
    </div>
  </section>
}
