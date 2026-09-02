export type EditorCommand =
  | 'bold' | 'italic' | 'code' | 'link' | 'heading' | 'bullet-list' | 'ordered-list'
  | 'paragraph' | 'heading-1' | 'heading-2' | 'heading-3' | 'heading-4' | 'heading-5' | 'heading-6'
  | 'strikethrough' | 'hard-break' | 'soft-break' | 'task-list' | 'blockquote' | 'table' | 'code-block' | 'image' | 'horizontal-rule'
  | 'list-tight' | 'list-loose' | 'list-indent' | 'list-outdent' | 'indented-code-block'
  | 'link-autolink' | 'link-remove' | 'image-update'
  | 'table-column-before' | 'table-column-after' | 'table-column-delete'
  | 'table-row-before' | 'table-row-after' | 'table-row-delete' | 'table-delete'
  | 'table-merge-cells' | 'table-split-cell' | 'table-toggle-header-row' | 'table-toggle-header-column'

interface ToolbarProps {
  source: boolean
  sourceOnly: boolean
  readOnly: boolean
  /** Whether the editor differs from the saved file: Save (accented) vs a quiet Saved. */
  dirty: boolean
  onCommand(command: EditorCommand): void
  onToggleSource(): void
  onSave(): void
}

const PRIMARY = primaryModifierLabel()

const tools: Array<{ command: EditorCommand; label: string; icon: string; shortcut?: string }> = [
  { command: 'bold', label: 'Bold', icon: 'B', shortcut: `${PRIMARY}+B` },
  { command: 'italic', label: 'Italic', icon: 'I', shortcut: `${PRIMARY}+I` },
  { command: 'code', label: 'Code span', icon: '</>', shortcut: `${PRIMARY}+Shift+C` },
  { command: 'link', label: 'Link', icon: 'a', shortcut: `${PRIMARY}+K` },
  { command: 'strikethrough', label: 'Strikethrough', icon: 'S' },
  { command: 'bullet-list', label: 'Bullet list', icon: '≔', shortcut: `${PRIMARY}+Shift+8` },
  { command: 'ordered-list', label: 'Ordered list', icon: '1.', shortcut: `${PRIMARY}+Shift+7` },
  { command: 'task-list', label: 'Task list', icon: '☑' },
  { command: 'blockquote', label: 'Blockquote', icon: '❝' },
  { command: 'table', label: 'Table', icon: '⊞' },
  { command: 'code-block', label: 'Fenced code block', icon: '▤' },
  { command: 'image', label: 'Image', icon: '▣' },
  { command: 'horizontal-rule', label: 'Horizontal rule', icon: '—' },
  { command: 'hard-break', label: 'Hard line break', icon: '↵' }
]

export const toolbarMenuItems: Partial<Record<EditorCommand, ReadonlyArray<{ command: EditorCommand; label: string }>>> = {
  link: [
    { command: 'link', label: 'Set link…' },
    { command: 'link-autolink', label: 'Autolink selection' },
    { command: 'link-remove', label: 'Remove link' },
  ],
  'bullet-list': [
    { command: 'bullet-list', label: 'Bullet list' },
    { command: 'list-tight', label: 'Tight spacing' },
    { command: 'list-loose', label: 'Loose spacing' },
    { command: 'list-indent', label: 'Indent item' },
    { command: 'list-outdent', label: 'Outdent item' },
  ],
  'ordered-list': [
    { command: 'ordered-list', label: 'Ordered list' },
    { command: 'list-tight', label: 'Tight spacing' },
    { command: 'list-loose', label: 'Loose spacing' },
    { command: 'list-indent', label: 'Indent item' },
    { command: 'list-outdent', label: 'Outdent item' },
  ],
  table: [
    { command: 'table', label: 'Insert table…' },
    { command: 'table-column-before', label: 'Column before' },
    { command: 'table-column-after', label: 'Column after' },
    { command: 'table-column-delete', label: 'Delete column' },
    { command: 'table-row-before', label: 'Row before' },
    { command: 'table-row-after', label: 'Row after' },
    { command: 'table-row-delete', label: 'Delete row' },
    { command: 'table-merge-cells', label: 'Merge cells' },
    { command: 'table-split-cell', label: 'Split cell' },
    { command: 'table-toggle-header-row', label: 'Toggle header row' },
    { command: 'table-toggle-header-column', label: 'Toggle header column' },
    { command: 'table-delete', label: 'Delete table' },
  ],
  'code-block': [
    { command: 'code-block', label: 'Fenced code block' },
    { command: 'indented-code-block', label: 'Indented code block' },
  ],
  image: [
    { command: 'image', label: 'Insert image…' },
    { command: 'image-update', label: 'Update selected image…' },
  ],
  'hard-break': [
    { command: 'hard-break', label: 'Hard line break' },
    { command: 'soft-break', label: 'Soft line break' },
  ],
}

/** Why the formatting tools are off, in the words the tooltip and the toolbar note use (§5.13). */
export function toolbarDisabledHint(source: boolean, readOnly: boolean): string | null {
  if (readOnly) return 'This document is read-only'
  if (source) return `Formatting tools work in the visual view · ${PRIMARY}+/ switches back`
  return null
}

/** Menu keys (§5.13): arrows and Home/End move between items; the index to focus, or null. */
export function menuItemAfter(count: number, current: number, key: string): number | null {
  if (count === 0) return null
  if (key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function Toolbar({ source, sourceOnly, readOnly, dirty, onCommand, onToggleSource, onSave }: ToolbarProps) {
  const disabled = readOnly || source
  const hint = toolbarDisabledHint(source, readOnly)
  const chooseBlockStyle = (event: MouseEvent<HTMLButtonElement>, command: EditorCommand) => {
    onCommand(command)
    event.currentTarget.closest('details')?.removeAttribute('open')
  }
  const tooltip = (tool: { label: string; shortcut?: string }) => hint ?? `${tool.label}${tool.shortcut ? ` · ${tool.shortcut}` : ''}`
  const toolButton = (tool: (typeof tools)[number]) => (
    <button
      type="button"
      key={tool.command}
      className={`tool tool-${tool.command}`}
      title={tooltip(tool)}
      aria-label={tool.label}
      disabled={disabled}
      onClick={() => onCommand(tool.command)}
    >{tool.icon}</button>
  )
  // Escape closes a menu; arrows walk its items; opening from the keyboard focuses the first item.
  const menuKeys = (event: KeyboardEvent<HTMLDetailsElement>) => {
    const details = event.currentTarget
    if (event.key === 'Escape') {
      event.preventDefault()
      details.removeAttribute('open')
      details.querySelector<HTMLElement>('summary')?.focus()
      return
    }
    const items = [...details.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (!details.open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      if (disabled) return
      event.preventDefault()
      details.setAttribute('open', '')
      window.requestAnimationFrame(() => details.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus())
      return
    }
    const next = menuItemAfter(items.length, current, event.key)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
  const toolMenu = (tool: (typeof tools)[number], items: ReadonlyArray<{ command: EditorCommand; label: string }>) => (
    <details className="tool-menu" key={tool.command} onKeyDown={menuKeys}>
      <summary
        className={`tool tool-${tool.command}`}
        title={tooltip(tool)}
        aria-label={tool.label}
        aria-haspopup="menu"
        aria-disabled={disabled}
        onClick={(event) => { if (disabled) event.preventDefault() }}
      >{tool.icon}</summary>
      <div role="menu" aria-label={`${tool.label} options`}>
        {items.map((item) => (
          <button type="button" role="menuitem" key={item.command} disabled={disabled} onClick={(event) => chooseBlockStyle(event, item.command)}>{item.label}</button>
        ))}
      </div>
    </details>
  )
  const renderTool = (tool: (typeof tools)[number]) => {
    const items = toolbarMenuItems[tool.command]
    return items ? toolMenu(tool, items) : toolButton(tool)
  }
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {tools.slice(0, 4).map(renderTool)}
      <span className="toolbar-divider" aria-hidden="true" />
      <details className="heading-menu" onKeyDown={menuKeys}>
        <summary aria-label="Heading level" aria-haspopup="menu" aria-disabled={disabled} title={hint ?? `Heading level · ${PRIMARY}+1…6`} onClick={(event) => { if (disabled) event.preventDefault() }}>H</summary>
        <div role="menu" aria-label="Heading levels">
          <button type="button" role="menuitem" disabled={disabled} onClick={(event) => chooseBlockStyle(event, 'paragraph')}>Paragraph</button>
          {[1, 2, 3, 4, 5, 6].map((level) => <button type="button" role="menuitem" disabled={disabled} key={level} onClick={(event) => chooseBlockStyle(event, `heading-${level}` as EditorCommand)}>Heading {level}</button>)}
        </div>
      </details>
      {tools.slice(4).map(renderTool)}
      {hint && <span className="toolbar-hint" role="note">{hint}</span>}
      <div className="toolbar-spacer" />
      <button type="button" className={`source-toggle ${source ? 'active' : ''}`} disabled={sourceOnly} title={sourceOnly ? 'This document can only open in source view' : `Source view · ${PRIMARY}+/`} onClick={onToggleSource}>{'{ }'} source</button>
      <button type="button" className="save-button" data-dirty={dirty} disabled={readOnly} onClick={onSave}>{dirty ? 'Save' : 'Saved'}</button>
    </div>
  )
}
import type { KeyboardEvent, MouseEvent } from 'react'
import { primaryModifierLabel } from '../../shared/primary-modifier'
