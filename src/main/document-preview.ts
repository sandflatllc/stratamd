import { BrowserWindow, WebContentsView, session, shell, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { documentKind, MAX_DOCUMENT_BYTES, type DocumentPreviewData, type DocumentBounds, type DocumentSource } from '../shared/documents'

/** Untrusted HTML gets its own disposable guest, with no preload, cookies or app protocols. */
export class DocumentPreviewHost {
  #window: BrowserWindow | null = null
  #records = new Map<string, { data: DocumentPreviewData; view?: WebContentsView; guest?: Session; source: DocumentSource; localPath?: string }>()
  #shown: WebContentsView | null = null
  #epoch = 0
  #overlay = false
  setOverlay(open: boolean): void { this.#overlay = open; this.#shown?.setVisible(!open) }
  #exports: string[] = []
  stagedIds(): string[] { return [...this.#records.values()].flatMap(record => record.source.kind === 'staged' ? [record.source.id] : []) }
  attach(window: BrowserWindow): void { this.#window = window }
  add(source: DocumentSource, bytes: Uint8Array, name: string, localPath?: string): DocumentPreviewData {
    const kind = documentKind(name)
    if (!kind || !bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`${name} is not a readable PDF or HTML document under 50 MB.`)
    const data = { id: randomUUID(), name, kind, bytes }
    this.#records.set(data.id, { data, source, ...(localPath ? { localPath } : {}) })
    return data
  }
  async show(report: DocumentBounds): Promise<void> {
    const epoch = ++this.#epoch
    const requested = report.id ? this.#records.get(report.id)?.view : undefined
    if (this.#shown && this.#shown !== requested) {
      if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(this.#shown)
      this.#shown = null
    }
    if (!report.id || !report.bounds || !this.#window || this.#window.isDestroyed()) return
    const record = this.#records.get(report.id)
    if (!record || record.data.kind !== 'html') throw new Error('The HTML document is no longer open.')
    if (!record.view) {
      const guest = session.fromPartition(`document-${report.id}`)
      record.guest = guest
      guest.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      guest.setPermissionCheckHandler(() => false)
      guest.on('will-download', event => event.preventDefault())
      // A unique HTTPS host supplies only this document. No network or local file fetch is allowed.
      const url = `https://document.invalid/${report.id}`
      guest.protocol.handle('https', request => request.url === url ? new Response(Buffer.from(record.data.bytes), { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
      } }) : new Response('', { status: 403 }))
      guest.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url && !details.url.startsWith('data:') }))
      const view = new WebContentsView({ webPreferences: { session: guest, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false } })
      record.view = view
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', event => event.preventDefault())
      view.webContents.on('will-attach-webview', event => event.preventDefault())
      try { await view.webContents.loadURL(url) }
      catch (error) { this.close(report.id); throw error }
    }
    if (epoch !== this.#epoch || this.#records.get(report.id) !== record || !this.#window || this.#window.isDestroyed()) return
    if (this.#shown !== record.view) this.#window.contentView.addChildView(record.view!)
    this.#shown = record.view!
    record.view!.setVisible(!this.#overlay)
    record.view!.setBounds({ x: Math.round(report.bounds.x), y: Math.round(report.bounds.y), width: Math.max(1, Math.round(report.bounds.width)), height: Math.max(1, Math.round(report.bounds.height)) })
  }
  close(id: string): void {
    const record = this.#records.get(id)
    if (record?.view) { if (this.#shown === record.view) { if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(record.view); this.#shown = null }; record.view.webContents.close() }
    record?.guest?.protocol.unhandle('https')
    record?.guest?.webRequest.onBeforeRequest(null)
    record?.guest?.removeAllListeners('will-download')
    record?.guest?.setPermissionRequestHandler(null)
    record?.guest?.setPermissionCheckHandler(null)
    this.#records.delete(id)
  }
  async external(id: string): Promise<void> {
    const record = this.#records.get(id)
    if (!record) throw new Error('The document is no longer open.')
    let path = record.localPath
    if (!path) { const directory = await mkdtemp(join(tmpdir(), 'stratamd-document-')); this.#exports.push(directory); path = join(directory, basename(record.data.name)); await writeFile(path, record.data.bytes, { mode: 0o600 }); record.localPath = path }
    const error = await shell.openPath(path)
    if (error) throw new Error(`Could not open ${record.data.name}: ${error}`)
  }
  async shutdown(): Promise<void> { for (const id of this.#records.keys()) this.close(id); await Promise.all(this.#exports.map(path => rm(path, { recursive: true, force: true }))) }
}
