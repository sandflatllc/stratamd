import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { MAX_DOCUMENT_BYTES, documentKind, type DocumentPreviewData, type DocumentSource } from '../../shared/documents'
GlobalWorkerOptions.workerSrc = workerUrl

export function DocumentPreview({ source: requestedSource, identity, onClose }: { source: DocumentSource; identity: string | null; onClose(): void }) {
  const [replacement, setReplacement] = useState<DocumentSource | null>(null)
  const source = replacement ?? requestedSource
  const picker = useRef<HTMLInputElement>(null)
  const replacementIds = useRef<string[]>([])
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const id of replacementIds.current) void window.strata.discardConversationAttachment(id).catch(() => undefined) } }, [])
  const [data, setData] = useState<DocumentPreviewData | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [sourceMode, setSourceMode] = useState(false)
  const [rendering, setRendering] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const hole = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false, opened: string | undefined
    setError(''); setData(null); setPdf(null); setPage(1)
    void window.strata.readDocument(source, identity).then(result => {
      opened = result.id
      if (cancelled) { void window.strata.closeDocumentPreview(result.id); return }
      setData(result)
    }).catch(failure => { if (!cancelled) setError(String(failure).replace(/^Error: /, '')) })
    return () => { cancelled = true; if (opened) void window.strata.closeDocumentPreview(opened).catch(() => undefined) }
  }, [source, identity, attempt])
  useEffect(() => {
    if (!data || data.kind !== 'pdf') return
    let cancelled = false
    const task = getDocument({ data: new Uint8Array(data.bytes), cMapUrl: new URL('pdf/cmaps/', document.baseURI).href, cMapPacked: true, standardFontDataUrl: new URL('pdf/standard_fonts/', document.baseURI).href, wasmUrl: new URL('pdf/wasm/', document.baseURI).href, iccUrl: new URL('pdf/iccs/', document.baseURI).href, enableXfa: false, maxImageSize: 16_000_000 })
    void task.promise.then(document => { if (!cancelled) setPdf(document) }).catch(failure => {
      if (!cancelled) setError(failure?.name === 'PasswordException' ? `${data.name} needs a password. Open it externally to unlock it.` : `${data.name} could not be rendered. The PDF may be damaged.`)
    })
    return () => { cancelled = true; void task.destroy() }
  }, [data])
  useEffect(() => {
    const element = canvas.current
    if (!pdf || !element) return
    let cancelled = false, render: RenderTask | undefined
    setRendering(true)
    void pdf.getPage(page).then(async current => {
      if (cancelled) return
      const viewport = current.getViewport({ scale: zoom / 100 })
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)))
      element.width = Math.ceil(viewport.width * ratio); element.height = Math.ceil(viewport.height * ratio)
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`
      render = current.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      await render.promise
      if (!cancelled) { element.dataset.page = String(page); element.dataset.zoom = String(zoom); setRendering(false) }
    }).catch(failure => { if (!cancelled && failure?.name !== 'RenderingCancelledException') { setRendering(false); setError(`${data?.name ?? source.name} page ${page} could not be rendered.`) } })
    return () => { cancelled = true; render?.cancel() }
  }, [pdf, page, zoom])
  useLayoutEffect(() => {
    if (!data || data.kind !== 'html' || sourceMode || error || !hole.current) return
    const element = hole.current
    let frame = 0, closed = false
    const report = () => { frame = 0; if (closed) return; const r = element.getBoundingClientRect(); void window.strata.reportDocumentBounds({ id: data.id, bounds: { x: r.x, y: r.y, width: r.width, height: r.height } }).catch(failure => { if (!closed) setError(String(failure)) }) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(report) }
    const observer = new ResizeObserver(schedule); observer.observe(element); window.addEventListener('resize', schedule); report()
    return () => { closed = true; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); void window.strata.reportDocumentBounds({ id: null, bounds: null }).catch(() => undefined) }
  }, [data, sourceMode, error])
  const locate = async (file: File) => {
    try {
      if (!documentKind(file.name) || !file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error(`${file.name} must be a PDF or HTML document under 50 MB.`)
      const staged = await window.strata.stageConversationAttachment({ name: file.name, mimeType: documentKind(file.name) === 'pdf' ? 'application/pdf' : 'text/html', bytes: new Uint8Array(await file.arrayBuffer()) })
      if (!mounted.current) { await window.strata.discardConversationAttachment(staged.id); return }
      replacementIds.current.push(staged.id)
      setReplacement({ kind: 'staged', id: staged.id, name: file.name })
    } catch (failure) { if (mounted.current) setError(String(failure).replace(/^Error: /, '')) }
  }
  return <>
    <input ref={picker} type="file" hidden accept=".pdf,.html,.htm" aria-label="Locate document file" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void locate(file) }} />
    <div className="preview-chrome document-toolbar"><strong>{data?.name ?? source.name}</strong><span>Read only</span>
      {data?.kind === 'html' ? <button type="button" onClick={() => setSourceMode(value => !value)}>{sourceMode ? 'Preview' : 'View source'}</button> : <>
        <button type="button" aria-label="Zoom out" disabled={!pdf || zoom <= 25} onClick={() => setZoom(value => Math.max(25, value - 25))}>−</button><span>{zoom}%</span>
        <button type="button" aria-label="Zoom in" disabled={!pdf || zoom >= 200} onClick={() => setZoom(value => Math.min(200, value + 25))}>+</button>
        <span aria-label="PDF page">{page} of {pdf?.numPages ?? '…'}</span><button type="button" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}>Previous page</button><button type="button" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}>Next page</button>
      </>}
      <button type="button" disabled={!data} onClick={() => data && void window.strata.openDocumentExternally(data.id).catch(failure => setError(String(failure)))}>Open externally</button>
    </div>
    <div className="preview-stage document-stage">
      {replacement && !error && <p className="document-replacement" role="status">Previewing a replacement. The original attachment has not changed.</p>}
      {error ? <div className="document-error" role="alert"><h2>{source.name} is unavailable</h2><p>{error}</p><button type="button" className="primary-button" onClick={() => picker.current?.click()}>Locate file</button><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button><button type="button" onClick={onClose}>Close preview</button></div>
        : !data ? <p role="status">Opening {source.name}…</p>
        : data.kind === 'html' ? sourceMode ? <pre className="document-source" aria-label="HTML source">{new TextDecoder().decode(data.bytes)}</pre> : <div className="document-html-hole" ref={hole} aria-label="HTML preview" />
        : <div className="document-paper" aria-busy={rendering || !pdf}><canvas ref={canvas} aria-label={`${data.name}, page ${page}`} />{!pdf && <p role="status">Reading PDF…</p>}</div>}
    </div>
  </>
}
