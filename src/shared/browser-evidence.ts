export interface BrowserEvidenceView {
  id: string
  tabId: string
  threadId: string
  name: string
  path: string
  mimeType: string
  sizeBytes: number
  createdAt: string
  status: 'saved' | 'transferring' | 'failed'
  destination: string | null
  error: string | null
  truncated?: boolean
  uploadedAttachmentId?: string
}

export interface BrowserEvidenceTransfer {
  /** The actual paired server identity. A retry may never silently change it. */
  destination: string
  upload(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<string>
}
