import { BrowserWindow, type WebContents } from 'electron'

/** Chromium frames stay on this computer. A separate, sandboxed canvas encodes
 * them, so navigation in the recorded page cannot destroy the recording. */
export class BrowserRecording {
  readonly startedAt = new Date().toISOString()
  truncated = false
  readonly #page: WebContents
  readonly #encoder: BrowserWindow
  #frames: Promise<unknown> = Promise.resolve()
  #failure: Error | null = null
  #stopped = false
  #paused = false
  get paused(): boolean { return this.#paused }
  pause(): void {
    this.#paused = true
    if (!this.#page.isDestroyed() && this.#ownsDebugger) void this.#page.debugger.sendCommand('Page.stopScreencast').catch(() => undefined)
  }
  #ownsDebugger = false
  #stop: Promise<Uint8Array> | null = null

  private constructor(page: WebContents) {
    this.#page = page
    this.#encoder = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  }

  static async start(page: WebContents): Promise<BrowserRecording> {
    const recording = new BrowserRecording(page)
    try { await recording.#start(); return recording }
    catch (error) { recording.dispose(); throw error }
  }

  async #start(): Promise<void> {
    await this.#encoder.loadURL('data:text/html,<canvas></canvas>')
    await this.#encoder.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('canvas');
      canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const mimeType = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('This Chromium cannot encode WebM recordings');
      const recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 2000000});
      const chunks = []; let size = 0; let failed = null; let truncated = false; let ready;
      window.recordingReady = new Promise(resolve => { ready = resolve; });
      recorder.ondataavailable = event => { if (size + event.data.size <= 50 * 1024 * 1024) { size += event.data.size; chunks.push(event.data); if (event.data.size) ready(); } else truncated = true; if (size >= 48 * 1024 * 1024 || truncated) { truncated = true; if(recorder.state !== 'inactive') recorder.stop(); } };
      recorder.onerror = event => { failed = event.error?.message || 'Recording encoding failed'; };
      window.drawFrame = async data => { const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode(); context.fillStyle = '#fff'; context.fillRect(0,0,canvas.width,canvas.height); const scale = Math.min(canvas.width/image.width,canvas.height/image.height); context.drawImage(image,0,0,image.width*scale,image.height*scale); track.requestFrame(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
      window.finishRecording = () => new Promise((resolve,reject) => {
        const finish = async () => { stream.getTracks().forEach(track => track.stop()); if(failed) return reject(new Error(failed)); const blob = new Blob(chunks,{type:mimeType}); const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for(let offset=0;offset<bytes.length;offset+=32768) binary += String.fromCharCode(...bytes.subarray(offset,offset+32768)); resolve({data:btoa(binary), truncated}); };
        if(recorder.state === 'inactive') void finish(); else { recorder.onstop = finish; recorder.stop(); }
      });
      recorder.start(100);
    })()`)
    if (this.#page.debugger.isAttached()) throw new Error('Close DevTools before recording this browser tab')
    this.#page.debugger.attach('1.3')
    this.#ownsDebugger = true
    this.#page.debugger.on('message', this.#onMessage)
    await this.#page.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 })
    // Include the current page even when no animation triggers another frame.
    const initial = await this.#page.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 80 }) as { data: string }
    await this.#encoder.webContents.executeJavaScript(`window.drawFrame(${JSON.stringify(initial.data)})`)
    // A stop immediately after start must still return an encoded frame.
    // MediaRecorder starts asynchronously; a paint alone does not prove it encoded.
    await this.#encoder.webContents.executeJavaScript(`new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Chromium did not encode the first recording frame')), 5000); window.recordingReady.then(() => { clearTimeout(timer); resolve(); }); })`)
  }

  readonly #onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    if (method !== 'Page.screencastFrame' || this.#stopped || this.#paused) return
    this.#frames = this.#frames.then(async () => {
      if (!this.#paused && !this.#stopped && typeof params.data === 'string') await this.#encoder.webContents.executeJavaScript(`window.drawFrame(${JSON.stringify(params.data)})`)
    }).catch(error => { this.#failure = error instanceof Error ? error : new Error(String(error)) }).finally(async () => {
      if (!this.#page.isDestroyed() && this.#ownsDebugger) await this.#page.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
    })
  }

  stop(): Promise<Uint8Array> {
    this.#stop ??= this.#finish()
    return this.#stop
  }

  async #finish(): Promise<Uint8Array> {
    this.#stopped = true
    try {
      if (!this.#page.isDestroyed()) await this.#page.debugger.sendCommand('Page.stopScreencast')
      await this.#frames
      if (this.#failure) throw this.#failure
      const encoded = await this.#encoder.webContents.executeJavaScript('window.finishRecording()') as { data: string; truncated: boolean }
      this.truncated = encoded.truncated
      const bytes = Buffer.from(encoded.data, 'base64')
      if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new Error('The browser did not produce a WebM recording')
      return bytes
    } finally { this.dispose() }
  }

  dispose(): void {
    this.#stopped = true
    if (!this.#page.isDestroyed() && this.#ownsDebugger) {
      this.#page.debugger.removeListener('message', this.#onMessage)
      try { this.#page.debugger.detach() } catch { /* page already detached */ }
    }
    this.#ownsDebugger = false
    if (!this.#encoder.isDestroyed()) this.#encoder.destroy()
  }
}
