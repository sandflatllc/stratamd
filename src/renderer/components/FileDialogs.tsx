import { useRef, useState } from 'react'
import { useDialogFocus } from '../useDialogFocus'

// Explorer file dialogs (§5.10): a name for a new or renamed file, and the
// confirmation before a file goes to the trash. Same modal pattern as Overlays.

function Backdrop({ children, onCancel }: { children: React.ReactNode; onCancel(): void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>{children}</div>
}

export function FileNameDialog({ title, action, initial, onCancel, onConfirm }: {
  title: string
  action: string
  initial: string
  onCancel(): void
  onConfirm(name: string): void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const [name, setName] = useState(initial)
  useDialogFocus(dialogRef, onCancel)
  const clean = name.trim()
  return (
    <Backdrop onCancel={onCancel}>
      <form
        // The section keeps the modal pattern; the form makes Enter confirm.
        onSubmit={(event) => { event.preventDefault(); if (clean) onConfirm(clean) }}
      >
        <section ref={dialogRef} tabIndex={-1} className="modal decision-modal file-name-modal" role="dialog" aria-modal="true" aria-labelledby="file-name-title">
          <h2 id="file-name-title">{title}</h2>
          <label className="file-name-field">
            <span>File name</span>
            <input
              data-dialog-initial-focus
              type="text"
              value={name}
              autoComplete="off"
              spellCheck={false}
              aria-label="File name"
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => {
                // Select the stem so typing replaces the name and keeps the extension.
                const value = event.currentTarget.value
                const stem = value.replace(/\.(?:md|markdown)$/iu, '').length
                event.currentTarget.setSelectionRange(0, stem)
              }}
            />
          </label>
          <p className="modal-fineprint">.md is added when the name has no extension.</p>
          <div className="modal-actions">
            <button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>
            <button type="submit" className="keep-button large" disabled={!clean}>{action}</button>
          </div>
        </section>
      </form>
    </Backdrop>
  )
}

export function TrashFileDialog({ name, onCancel, onConfirm }: { name: string; onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  return (
    <Backdrop onCancel={onCancel}>
      <section ref={dialogRef} tabIndex={-1} className="modal decision-modal trash-file-modal" role="dialog" aria-modal="true" aria-labelledby="trash-file-title">
        <h2 id="trash-file-title">Move {name} to the trash?</h2>
        <p>The file goes to your system trash, where you can bring it back. StrataMD forgets its review notes.</p>
        <div className="modal-actions">
          <button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger-button" onClick={onConfirm}>Move to trash</button>
        </div>
      </section>
    </Backdrop>
  )
}
