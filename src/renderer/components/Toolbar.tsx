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

const tools: Array<{ command: EditorCommand; label: string; icon: string; shortcut?: string }> = [
  { command: 'bold', label: 'Bold', icon: 'B', shortcut: 'Ctrl+B' },
  { command: 'italic', label: 'Italic', icon: 'I', shortcut: 'Ctrl+I' },
  { command: 'code', label: 'Code span', icon: '</>', shortcut: 'Ctrl+Shift+C' },
  { command: 'link', label: 'Link', icon: 'a', shortcut: 'Ctrl+K' },
  { command: 'strikethrough', label: 'Strikethrough', icon: 'S' },
  { command: 'bullet-list', label: 'Bullet list', icon: '≔', shortcut: 'Ctrl+Shift+8' },
  { command: 'ordered-list', label: 'Ordered list', icon: '1.', shortcut: 'Ctrl+Shift+7' },
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

export function Toolbar({ source, sourceOnly, readOnly, dirty, onCommand, onToggleSource, onSave }: ToolbarProps) {
  const chooseBlockStyle = (event: MouseEvent<HTMLButtonElement>, command: EditorCommand) => {
    onCommand(command)
    event.currentTarget.closest('details')?.removeAttribute('open')
  }
  const toolButton = (tool: (typeof tools)[number]) => (
    <button
      type="button"
      key={tool.command}
      className={`tool tool-${tool.command}`}
      title={`${tool.label}${tool.shortcut ? ` · ${tool.shortcut}` : ''}`}
      aria-label={tool.label}
      disabled={readOnly || source}
      onClick={() => onCommand(tool.command)}
    >{tool.icon}</button>
  )
  const toolMenu = (tool: (typeof tools)[number], items: ReadonlyArray<{ command: EditorCommand; label: string }>) => (
    <details className="tool-menu" key={tool.command} onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.currentTarget.removeAttribute('open')
      event.currentTarget.querySelector<HTMLElement>('summary')?.focus()
    }}>
      <summary
        className={`tool tool-${tool.command}`}
        title={`${tool.label}${tool.shortcut ? ` · ${tool.shortcut}` : ''}`}
        aria-label={tool.label}
        aria-disabled={readOnly || source}
        onClick={(event) => { if (readOnly || source) event.preventDefault() }}
      >{tool.icon}</summary>
      <div role="menu" aria-label={`${tool.label} options`}>
        {items.map((item) => (
          <button type="button" role="menuitem" key={item.command} disabled={readOnly || source} onClick={(event) => chooseBlockStyle(event, item.command)}>{item.label}</button>
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
      <details className="heading-menu">
        <summary aria-label="Heading level" title="Heading level · Ctrl+1…6">H</summary>
        <div role="menu" aria-label="Heading levels">
          <button type="button" role="menuitem" disabled={readOnly || source} onClick={(event) => chooseBlockStyle(event, 'paragraph')}>Paragraph</button>
          {[1, 2, 3, 4, 5, 6].map((level) => <button type="button" role="menuitem" disabled={readOnly || source} key={level} onClick={(event) => chooseBlockStyle(event, `heading-${level}` as EditorCommand)}>Heading {level}</button>)}
        </div>
      </details>
      {tools.slice(4).map(renderTool)}
      <div className="toolbar-spacer" />
      <button type="button" className={`source-toggle ${source ? 'active' : ''}`} disabled={sourceOnly} title={sourceOnly ? 'This document can only open in source view' : 'Source view · Ctrl+/'} onClick={onToggleSource}>{'{ }'} source</button>
      <button type="button" className="save-button" data-dirty={dirty} disabled={readOnly} onClick={onSave}>{dirty ? 'Save' : 'Saved'}</button>
    </div>
  )
}
import type { MouseEvent } from 'react'
