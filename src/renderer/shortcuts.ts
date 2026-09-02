import { createEditorKeymap } from '../editor/commands'
import { isMacLike, primaryModifierLabel } from '../shared/primary-modifier'

// The F1 shortcut sheet (§5.12): the editor's keymap, described in plain
// words, plus the keys the shell handles outside the editor. Anything in the
// keymap without a description here (ProseMirror's base bindings) is left out.

export interface ShortcutEntry {
  keys: string
  action: string
}

export interface ShortcutGroup {
  title: string
  entries: ShortcutEntry[]
}

const EDITOR_ACTIONS: Record<string, string> = {
  'Mod-b': 'Bold',
  'Mod-i': 'Italic',
  'Shift-Mod-c': 'Code span',
  'Mod-k': 'Add or edit a link',
  'Mod-0': 'Paragraph',
  'Mod-1': 'Heading 1',
  'Mod-2': 'Heading 2',
  'Mod-3': 'Heading 3',
  'Mod-4': 'Heading 4',
  'Mod-5': 'Heading 5',
  'Mod-6': 'Heading 6',
  'Shift-Mod-7': 'Numbered list',
  'Shift-Mod-8': 'Bullet list',
  'Shift-Enter': 'Line break',
  Tab: 'Next table cell, or indent a list item',
  'Shift-Tab': 'Previous table cell, or outdent a list item',
  'Mod-z': 'Undo',
  'Shift-Mod-z': 'Redo',
  'Mod-s': 'Save',
  'Mod-Enter': 'Send to agents',
  'Mod-/': 'Switch between visual and source view',
}

const EDITOR_ORDER = Object.keys(EDITOR_ACTIONS)

/** 'Shift-Mod-c' becomes 'Ctrl+Shift+C' (or 'Cmd+Shift+C' on a Mac). */
export function formatKeys(binding: string, mac: boolean = isMacLike()): string {
  const parts = binding.split('-')
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  const ordered: string[] = []
  if (modifiers.has('Mod')) ordered.push(primaryModifierLabel(mac))
  if (modifiers.has('Ctrl')) ordered.push('Ctrl')
  if (modifiers.has('Alt')) ordered.push('Alt')
  if (modifiers.has('Shift')) ordered.push('Shift')
  return [...ordered, key.length === 1 ? key.toUpperCase() : key].join('+')
}

export function shortcutGroups(keymapKeys: readonly string[] = Object.keys(createEditorKeymap()), mac: boolean = isMacLike()): ShortcutGroup[] {
  const primary = primaryModifierLabel(mac)
  const editor = EDITOR_ORDER
    .filter((binding) => keymapKeys.includes(binding))
    .map((binding): ShortcutEntry => ({ keys: formatKeys(binding, mac), action: EDITOR_ACTIONS[binding]! }))
  return [
    { title: 'Writing', entries: editor },
    {
      title: 'Documents',
      entries: [
        { keys: `${primary}+N`, action: 'New file beside the open document' },
        { keys: `${primary}+O`, action: 'Open a file' },
        { keys: `${primary}+W`, action: 'Close the tab' },
        { keys: 'Ctrl+Tab · Ctrl+Shift+Tab', action: 'Next or previous tab' },
        { keys: `${primary}+PageDown · ${primary}+PageUp`, action: 'Next or previous tab' },
        { keys: `${primary}+F`, action: 'Find in the document' },
        { keys: 'F3 · Shift+F3', action: 'Next or previous match' },
      ],
    },
    {
      title: 'Review',
      entries: [
        { keys: 'F7 · Shift+F7', action: 'Next or previous change waiting for review' },
        { keys: 'F8 · Shift+F8', action: 'Next or previous open comment or question' },
        { keys: 'C · Q · S', action: 'Comment, question, or suggest on text you selected with the mouse' },
        { keys: 'Escape', action: 'Close the topmost panel, menu, or note' },
      ],
    },
    {
      title: 'Window',
      entries: [
        { keys: `${primary}+= · ${primary}+-`, action: 'Zoom the pane under the pointer in or out' },
        { keys: 'F1', action: 'This list' },
      ],
    },
  ]
}
