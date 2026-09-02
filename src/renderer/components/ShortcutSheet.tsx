import { useRef } from 'react'
import { useDialogFocus } from '../useDialogFocus'
import { shortcutGroups } from '../shortcuts'

/** F1: every shortcut in plain words, generated from the editor keymap plus the shell's keys (§5.12). */
export function ShortcutSheet({ onClose }: { onClose(): void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const groups = shortcutGroups()
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} tabIndex={-1} className="modal shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <p className="modal-subtitle">Press Escape to close this list.</p>
        <div className="shortcut-groups">
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.entries.map((entry) => (
                  <div key={`${group.title}:${entry.keys}`}>
                    <dt><kbd>{entry.keys}</kbd></dt>
                    <dd>{entry.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-actions"><button type="button" className="quiet-button" data-dialog-initial-focus onClick={onClose}>Close</button></div>
      </section>
    </div>
  )
}
