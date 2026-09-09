import type { DocumentSource } from '../shared/documents'
export const DOCUMENT_PREVIEW_EVENT = 'strata-open-document'
export function openDocumentPreview(source: DocumentSource, projectId?: string): void {
  window.dispatchEvent(new CustomEvent(DOCUMENT_PREVIEW_EVENT, { detail: { source, projectId } }))
}
