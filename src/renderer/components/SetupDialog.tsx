import { DialogResize } from './DialogResize'
import { createPortal } from 'react-dom'
import { useRef, type ReactNode } from 'react'
import { useDialogFocus } from '../useDialogFocus'
import { ArrowLeftIcon, ChevronRightIcon, XIcon } from '../icons/lucide'

export function SetupDialog({ title, subtitle, back, onClose, children, footer, className = '', tools }: {
  title: string; subtitle?: string; back?: { label: string; action(): void } | undefined; onClose(): void
  children: ReactNode; footer: ReactNode; className?: string; tools?: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useDialogFocus(ref, onClose)
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={ref} tabIndex={-1} className={`modal setup-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="setup-dialog-header"><div>{back && <button type="button" className="text-action setup-back" onClick={back.action}><ArrowLeftIcon />{back.label}</button>}<h2>{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}</div>{tools}<button type="button" className="quiet-button icon-button" aria-label="Close dialog" onClick={onClose}><XIcon /></button></header>
      <div className="setup-dialog-body">{children}</div>
      <footer className="modal-actions parity-dialog-footer">{footer}</footer>
      <DialogResize name={title} />
    </section>
  </div>, document.querySelector('.app-shell') ?? document.body)
}
export function SourceRow({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick(): void }) {
  return <button type="button" className="setup-source-row" onClick={onClick}><span className="setup-source-icon">{icon}</span><span><strong>{title}</strong><small>{description}</small></span><ChevronRightIcon /></button>
}
