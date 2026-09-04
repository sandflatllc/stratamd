import { useRef } from 'react'
import type { AttachmentView, ConflictDecision, ConflictView, DocumentTabView, HunkView } from '../../shared/contracts'
import { reviewExcerpt } from '../../editor/review'
import { useDialogFocus } from '../useDialogFocus'

function Backdrop({ children, onCancel }: { children: React.ReactNode; onCancel?(): void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel?.() }}>{children}</div>
}

export function MixedRevertDialog({ hunk, onCancel, onConfirm }: { hunk: HunkView; onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  return (
    <Backdrop onCancel={onCancel}><section ref={dialogRef} tabIndex={-1} className="modal decision-modal mixed-revert-modal" role="dialog" aria-modal="true" aria-labelledby="mixed-title">
      <h2 id="mixed-title">Revert this change?</h2>
      <p>You've edited inside this change. Reverting puts the earlier text back and <strong className="danger-text">discards your edits inside it</strong>. Agents see the revert as your change.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>Revert &amp; discard</button></div>
    </section></Backdrop>
  )
}

export function DetachDialog({ attachment, onCancel, onConfirm }: { attachment: AttachmentView; onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  const count = attachment.queuedSendCount
  return (
    <Backdrop onCancel={onCancel}><section ref={dialogRef} tabIndex={-1} className="modal decision-modal detach-modal" role="dialog" aria-modal="true" aria-labelledby="detach-title">
      <h2 id="detach-title">Detach {attachment.agent.name}?</h2>
      <p>{attachment.agent.name} still has {count === 1 ? 'an update you sent that it has' : `${count} updates you sent that it has`} not acknowledged. Detaching <strong className="danger-text">discards {count === 1 ? 'it' : 'them'}</strong> but leaves the thread untouched.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>Detach</button></div>
    </section></Backdrop>
  )
}

export function RecoveryDialog({ fileName, onChoose }: { fileName: string; onChoose(choice: 'recover' | 'discard'): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, undefined)
  return (
    <Backdrop><section ref={dialogRef} tabIndex={-1} className="modal decision-modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Recover unsaved edits?</h2>
      <p>It looks like the app closed while {fileName} had edits that were never saved.</p>
      <p className="modal-fineprint">StrataMD never silently overwrites either side.</p>
      <div className="modal-actions"><button type="button" className="outline-danger-button" onClick={() => onChoose('discard')}>Use the saved file</button><button type="button" className="keep-button large" data-dialog-initial-focus onClick={() => onChoose('recover')}>Recover my edits</button></div>
    </section></Backdrop>
  )
}

export function CloseTabDialog({ tab, onChoose }: { tab: DocumentTabView; onChoose(choice: 'save' | 'discard' | 'cancel'): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const cancel = () => onChoose('cancel')
  useDialogFocus(dialogRef, cancel)
  return (
    <Backdrop onCancel={cancel}><section ref={dialogRef} tabIndex={-1} className="modal decision-modal close-tab-modal" role="dialog" aria-modal="true" aria-labelledby="close-title">
      <h2 id="close-title">Close {tab.name}?</h2>
      <p>You have unsaved edits. Reviews you haven't finished are kept either way. Discard throws away everything that was never saved.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={() => onChoose('cancel')}>Cancel</button><button type="button" className="outline-danger-button" onClick={() => onChoose('discard')}>Discard</button><button type="button" className="keep-button large" onClick={() => onChoose('save')}>Save</button></div>
    </section></Backdrop>
  )
}

export function ConflictDialog({ conflict, fileName, onChoose }: { conflict: ConflictView; fileName: string; onChoose(choice: ConflictDecision): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, undefined)
  return (
    <Backdrop><section ref={dialogRef} tabIndex={-1} className="modal conflict-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <h2 id="conflict-title">This file was changed outside StrataMD while you were editing</h2>
      <p className="modal-subtitle">{fileName} changed while you had unsaved edits in {conflict.label}. Pick a side for this block.</p>
      <div className="conflict-choices">
        <button type="button" onClick={() => onChoose('mine')}><small className="danger-text">Your version · unsaved</small><span>{conflict.mine}</span><strong className="danger-text">Keep mine →</strong></button>
        <button type="button" onClick={() => onChoose('incoming')}><small>Changed outside</small><span>{conflict.incoming}</span><strong>Take theirs →</strong></button>
      </div>
      <p className="modal-fineprint">Blocks with no conflict were already applied and are waiting for your review.</p>
    </section></Backdrop>
  )
}

/** Resolving an open suggestion is neither Accept nor Reject; say so before hiding it (PRD §6.5). */
export function ResolveSuggestionDialog({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  return (
    <Backdrop onCancel={onCancel}><section ref={dialogRef} tabIndex={-1} className="modal decision-modal resolve-suggestion-modal" role="dialog" aria-modal="true" aria-labelledby="resolve-suggestion-title">
      <h2 id="resolve-suggestion-title">Resolve this suggestion?</h2>
      <p>This suggestion hasn't been accepted or rejected. Resolving hides it without changing the text.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="button" className="keep-button large" onClick={onConfirm}>Resolve anyway</button></div>
    </section></Backdrop>
  )
}

/** Reverting every pending change by one author at once (PRD §6.9 rail). */
export function RevertAllDialog({ name, hunks, onCancel, onConfirm }: { name: string; hunks: HunkView[]; onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  const mixed = hunks.filter((hunk) => hunk.status === 'mixed').length
  const first = hunks[0]
  const glimpse = first ? reviewExcerpt((first.added.length > 0 ? first.added : first.removed).join(' ')) : ''
  return (
    <Backdrop onCancel={onCancel}><section ref={dialogRef} tabIndex={-1} className="modal decision-modal revert-all-modal" role="dialog" aria-modal="true" aria-labelledby="revert-all-title">
      <h2 id="revert-all-title">Revert {hunks.length} changes by {name}?</h2>
      <p>Every change by {name} that is still waiting for your review goes back to the earlier text{glimpse ? <>, starting with “{glimpse}”</> : null}.{mixed > 0 ? <> You've edited inside {mixed === 1 ? 'one of them' : `${mixed} of them`}; <strong className="danger-text">those edits are discarded too</strong>.</> : null} Agents see the reverts as your changes. Each one can be undone separately.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>Revert all</button></div>
    </section></Backdrop>
  )
}
