import type { WindowState, WindowAction } from '../../shared/contracts'

export function WindowControls({ state, onAction }: { state: WindowState | null; onAction(action: WindowAction): void }) {
  if (state?.chrome !== 'custom' || state.fullscreen) return null
  return <div className="window-controls" role="group" aria-label="Window controls">
    <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => onAction('minimize')}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 8h10" /></svg>
    </button>
    <button type="button" aria-label={state.maximized ? 'Restore window' : 'Maximize window'} title={state.maximized ? 'Restore' : 'Maximize'} onClick={() => onAction('toggleMaximize')}>
      <svg viewBox="0 0 12 12" aria-hidden="true">{state.maximized
        ? <><path d="M4 3V1.5h6.5V8H9" /><rect x="1.5" y="4" width="6.5" height="6.5" /></>
        : <rect x="1.5" y="1.5" width="9" height="9" />}</svg>
    </button>
    <button type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => onAction('close')}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8m0-8-8 8" /></svg>
    </button>
  </div>
}
