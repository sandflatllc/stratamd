import '@fontsource/baloo-2/latin-500.css'
import '@fontsource/baloo-2/latin-600.css'
import '@fontsource/baloo-2/latin-700.css'
import '@fontsource/baloo-2/latin-800.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createStrataEditor } from '../editor/index'
import { startAmbientTicker } from './ambientTicker'
import { App } from './App'
import { Boundary } from './components/Boundary'
import { sendErrorReport } from './reportError'
import type { RendererEditorFactory } from './editorAdapter'
import { registerItalicFaces } from './fonts'
import './styles.css'

const createRendererEditor: RendererEditorFactory = (element, options) => {
  const handle = createStrataEditor(element, {
    content: options.content,
    sourceMode: options.sourceMode,
    readOnly: options.readOnly,
    pendingHunks: options.pendingHunks as never,
    annotations: options.annotations as never,
    onChange: options.onChange,
    onSelection: options.onSelection,
    onOpenAnnotation: options.onOpenAnnotation,
    onAdjustAnnotation: options.onAdjustAnnotation,
    onKeepHunk: options.onKeepHunk,
    onRevertHunk: options.onRevertHunk,
    onAcceptSuggestion: options.onAcceptSuggestion,
    onRejectSuggestion: options.onRejectSuggestion,
    onUndo: options.onUndo,
    onRedo: options.onRedo,
    historyStep: options.historyStep,
    ...(options.restore ? { restore: options.restore } : {}),
    ...(options.restoreCold ? { restoreCold: options.restoreCold } : {}),
    documentPath: element.dataset.documentPath ?? '',
    resolveLocalImage: options.resolveLocalImage
  })
  return {
    setContent: (content) => handle.setContent(content),
    setHistoryStep: (step) => handle.setHistoryStep(step),
    exportState: () => handle.exportState(),
    setReviewState: (hunks) => handle.setReviewState(hunks as never),
    setAnnotations: (annotations) => handle.setAnnotations(annotations as never),
    getMarkdown: () => handle.getMarkdown(),
    getState: () => handle.getState(),
    focus: () => handle.focus(),
    setReadOnly: (readOnly) => handle.setReadOnly(readOnly),
    toggleSource: (source) => { handle.toggleSource(source) },
    setActiveAnnotation: (id) => handle.setActiveAnnotation(id),
    command: (command) => handle.command(command),
    jumpToHunk: (id) => handle.jumpToHunk(id),
    jumpToAnnotation: (id) => handle.jumpToAnnotation(id),
    annotationCoordinates: (id) => handle.annotationCoordinates(id),
    replaceSelection: (text) => handle.replaceSelection(text),
    destroy: () => handle.destroy()
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')
registerItalicFaces()

// Nets for what boundaries cannot catch — event handlers and ProseMirror's
// own DOM dispatch (docs/plans/completed/crash-hardening-plan.md §3). Report only; no UI change.
window.addEventListener('error', (event) => {
  const error: unknown = event.error
  sendErrorReport('window', event.message || 'Unhandled error', error instanceof Error ? error.stack : undefined)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  sendErrorReport(
    'window:promise',
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined
  )
})

createRoot(root, {
  // The boundary owns caught-error reporting (§3); silence React's default
  // console replay so the console-message forwarder cannot record a copy.
  onCaughtError: () => undefined,
  onUncaughtError: (error, info) => {
    const named = error instanceof Error ? error : undefined
    sendErrorReport('react:uncaught', named?.message ?? String(error), named?.stack, info.componentStack ?? undefined)
  }
}).render(
  <StrictMode>
    <Boundary region="window" root>
      <App createEditor={createRendererEditor} />
    </Boundary>
  </StrictMode>
)
startAmbientTicker()
