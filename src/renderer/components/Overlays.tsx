import { useRef } from 'react'
import type { AttachmentView, ConflictDecision, ConflictView, DocumentTabView, HunkView } from '../../shared/contracts'
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

export function DisconnectDialog({ attachment, onCancel, onConfirm }: { attachment: AttachmentView; onCancel(): void; onConfirm(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onCancel)
  const count = attachment.queuedSendCount
  return (
    <Backdrop onCancel={onCancel}><section ref={dialogRef} tabIndex={-1} className="modal decision-modal disconnect-modal" role="dialog" aria-modal="true" aria-labelledby="disconnect-title">
      <h2 id="disconnect-title">Disconnect {attachment.agent.name}?</h2>
      <p>{attachment.agent.name} still has {count === 1 ? 'an update you sent that it has' : `${count} updates you sent that it has`} not picked up. Disconnecting <strong className="danger-text">throws {count === 1 ? 'it' : 'them'} away</strong>.</p>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>Disconnect</button></div>
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
      <h2 id="conflict-title">External write conflicts with your edits</h2>
      <p className="modal-subtitle">{fileName} changed while you had unsaved edits in {conflict.label}. Pick a side for this block.</p>
      <div className="conflict-choices">
        <button type="button" onClick={() => onChoose('mine')}><small className="danger-text">YOURS · unsaved</small><span>{conflict.mine}</span><strong className="danger-text">Keep mine →</strong></button>
        <button type="button" onClick={() => onChoose('incoming')}><small>INCOMING</small><span>{conflict.incoming}</span><strong>Take incoming →</strong></button>
      </div>
      <p className="modal-fineprint">Blocks with no conflict were already applied and are waiting for your review.</p>
    </section></Backdrop>
  )
}
