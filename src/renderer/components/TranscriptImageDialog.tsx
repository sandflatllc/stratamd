import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DraftAttachment } from '../conversationDrafts'
import { useDialogFocus } from '../useDialogFocus'
import { loadImage, renderMarkedCapture } from '../visualImage'
import './transcript-image.css'

export function TranscriptImageDialog({ image, onClose, onAnnotate }: { image: { url: string; name: string }; onClose(): void; onAnnotate?: ((attachment: DraftAttachment) => void) | undefined }) {
  const dialog = useRef<HTMLElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useDialogFocus(dialog, onClose)
  const changeZoom = (factor: number) => setZoom(value => Math.max(.25, Math.min(8, value * factor)))
  useEffect(() => {
    const host = viewport.current
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault(); event.stopPropagation()
      changeZoom(Math.exp(-event.deltaY * .002))
    }
    host?.addEventListener('wheel', wheel, { passive: false })
    return () => host?.removeEventListener('wheel', wheel)
  }, [])
  const annotate = async () => {
    if (!onAnnotate || busy) return
    setBusy(true); setError('')
    try {
      const original = await loadImage(image.url)
      const bytes = await renderMarkedCapture(original, original.naturalWidth, original.naturalHeight, [], [])
      const name = `${image.name.replace(/\.[^.]+$/, '') || 'Transcript image'}.png`
      const staged = await window.strata.stageConversationAttachment({ name, mimeType: 'image/png', bytes })
      onClose()
      onAnnotate({ kind: 'image', id: staged.id, name, mimeType: 'image/png', sizeBytes: staged.sizeBytes })
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false) }
  }
  return createPortal(<div className="modal-backdrop transcript-image-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialog} className="transcript-image-dialog" role="dialog" aria-modal="true" aria-label="Inspect image" tabIndex={-1} onKeyDown={event => {
      if (!event.ctrlKey && !event.metaKey) return
      if (!['+', '=', '-', '0'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      if (event.key === '0') setZoom(1)
      else changeZoom(event.key === '-' ? 1 / 1.2 : 1.2)
    }}>
      <header><strong title={image.name}>{image.name}</strong><div>
        <button type="button" onClick={() => changeZoom(1 / 1.2)} aria-label="Zoom out">−</button><output aria-label="Image zoom">{Math.round(zoom * 100)}%</output><button type="button" onClick={() => changeZoom(1.2)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setZoom(1)}>Fit</button>
        {onAnnotate && <button type="button" disabled={busy} onClick={() => void annotate()}>{busy ? 'Preparing…' : 'Annotate'}</button>}
        <button type="button" aria-label="Close image" disabled={busy} onClick={onClose}>Close</button>
      </div></header>
      <div ref={viewport} className="transcript-image-viewport"><div className="transcript-image-size" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}><img src={image.url} alt={image.name} draggable={false} /></div></div>
      {error && <p role="alert">{error}</p>}
    </section>
  </div>, document.querySelector('.app-shell') ?? document.body)
}
