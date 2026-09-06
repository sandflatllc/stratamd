import { EngineScope } from './EngineScope'
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
    tableViews: options.tableViews,
    foldedHeadings: options.foldedHeadings,
    ...(options.visualCodeSessions ? { visualCodeSessions: options.visualCodeSessions } : {}),
    ...(options.imageInspectionState ? { imageInspectionState: options.imageInspectionState } : {}),
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
    onToggleSource: options.onToggleSource,
    onHeadings: options.onHeadings,
    onTableView: options.onTableView,
    ...(options.focusedTable !== undefined ? { focusedTable: options.focusedTable } : {}),
    ...(options.onTableFocus ? { onTableFocus: options.onTableFocus } : {}),
    onFold: options.onFold,
    historyStep: options.historyStep,
    ...(options.restore ? { restore: options.restore } : {}),
    ...(options.restoreCold ? { restoreCold: options.restoreCold } : {}),
    documentPath: element.dataset.documentPath ?? '',
    resolveLocalImage: options.resolveLocalImage,
    resolveLocalMarkdown: options.resolveLocalMarkdown,
    onOpenLocalMarkdown: options.onOpenLocalMarkdown,
  })
  return {
    setContent: (content) => handle.setContent(content),
    setHistoryStep: (step) => handle.setHistoryStep(step),
    exportState: () => handle.exportState(),
    setReviewState: (hunks) => handle.setReviewState(hunks as never),
    setAnnotations: (annotations) => handle.setAnnotations(annotations as never),
    setTableViews: (states) => handle.setTableViews(states),
    setFoldedHeadings: (headings) => handle.setFoldedHeadings(headings),
    getMarkdown: () => handle.getMarkdown(),
    getState: () => handle.getState(),
    focus: () => handle.focus(),
    setReadOnly: (readOnly) => handle.setReadOnly(readOnly),
    toggleSource: (source) => { handle.toggleSource(source) },
    setActiveAnnotation: (id) => handle.setActiveAnnotation(id),
    command: (command) => handle.command(command),
    jumpToHunk: (id) => handle.jumpToHunk(id),
    jumpToAnnotation: (id) => handle.jumpToAnnotation(id),
    jumpToHeading: (id) => handle.jumpToHeading(id),
    headingSource: (id) => handle.headingSource(id),
    replaceSelection: (text) => handle.replaceSelection(text),
    pasteText: (text) => handle.pasteText(text),
    selectAll: () => handle.selectAll(),
    find: (query) => handle.find(query),
    findStep: (direction) => handle.findStep(direction),
    closeFind: () => handle.closeFind(),
    destroy: () => handle.destroy()
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')
registerItalicFaces()

if (window.strataMermaidProofEnabled === '1') {
  const proofHost = document.createElement('div')
  proofHost.hidden = true
  proofHost.dataset.mermaidProof = 'true'
  document.body.append(proofHost)
  let proofId = 0
  window.strataMermaidProof = {
    async render(source, normalizeBreaks = false) {
      const { parseMermaidSvg, renderMermaid } = await import('../editor/mermaid-renderer')
      const result = await renderMermaid(`strata-mermaid-proof-${proofId += 1}`, source, { normalizeBreaks })
      const svg = parseMermaidSvg(result.svg)
      proofHost.append(svg)
      return {
        durationMs: result.durationMs,
        normalizedBreaks: result.normalizedBreaks,
        text: svg.textContent ?? '',
      }
    },
    clear() {
      proofHost.replaceChildren()
    },
  }
}

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
      <EngineScope><App createEditor={createRendererEditor} /></EngineScope>
    </Boundary>
  </StrictMode>
)
startAmbientTicker()
