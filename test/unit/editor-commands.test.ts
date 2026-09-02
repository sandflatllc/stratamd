import { EditorState, NodeSelection, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { CellSelection } from 'prosemirror-tables'
import { describe, expect, it } from 'vitest'
import {
  createEditorCommands,
  createEditorKeymap,
  isLocalImageSource,
  parseMarkdownForEditor,
  popoverPosition,
  serializeEditorDocument,
  strataSchema,
} from '../../src/editor/index.js'
import { menuItemAfter, toolbarDisabledHint, toolbarMenuItems, type EditorCommand } from '../../src/renderer/components/Toolbar.js'
import { bareHotkeysApply, isAnnotationDismissKey } from '../../src/renderer/components/AnnotationComposer.js'

function run(command: Command, state: EditorState): EditorState {
  let transaction: Transaction | undefined
  if (typeof command !== 'function') throw new TypeError('Expected a command')
  expect(command(state, (next) => { transaction = next })).toBe(true)
  return transaction ? state.apply(transaction) : state
}

describe('editor commands and keymap', () => {
  it('exposes every required shortcut through the platform Mod binding', () => {
    const keys = createEditorKeymap()
    expect(keys).toEqual(expect.objectContaining({
      'Mod-b': expect.any(Function),
      'Mod-i': expect.any(Function),
      'Mod-k': expect.any(Function),
      'Shift-Mod-c': expect.any(Function),
      'Mod-1': expect.any(Function),
      'Mod-6': expect.any(Function),
      'Shift-Mod-7': expect.any(Function),
      'Shift-Mod-8': expect.any(Function),
      'Mod-s': expect.any(Function),
      'Mod-Enter': expect.any(Function),
      'Mod-/': expect.any(Function),
      'Shift-Enter': expect.any(Function),
      Tab: expect.any(Function),
      'Shift-Tab': expect.any(Function),
    }))
    expect(isAnnotationDismissKey('Escape')).toBe(true)
    expect(isAnnotationDismissKey('Enter')).toBe(false)
  })

  it('changes heading level while retaining the source identity', () => {
    const parsed = parseMarkdownForEditor('Paragraph\n')
    let state = EditorState.create({ doc: parsed.doc })
    state = run(createEditorCommands().setHeading(3), state)
    expect(state.doc.firstChild?.type).toBe(strataSchema.nodes.heading)
    expect(state.doc.firstChild?.attrs).toEqual(expect.objectContaining({ level: 3, sourceId: 'block-0' }))
  })

  it('creates lists, task items, tables, hard breaks, and horizontal rules', () => {
    const parsed = parseMarkdownForEditor('Item\n')
    let listState = EditorState.create({ doc: parsed.doc })
    listState = run(createEditorCommands().toggleTaskList, listState)
    expect(listState.doc.firstChild?.type).toBe(strataSchema.nodes.bullet_list)
    expect(listState.doc.firstChild?.firstChild?.attrs.checked).toBe(false)

    let tableState = EditorState.create({ doc: parsed.doc })
    tableState = run(createEditorCommands().insertTable({ rows: 3, columns: 2 }), tableState)
    let tableFound = false
    tableState.doc.descendants((node) => { if (node.type === strataSchema.nodes.table) tableFound = true })
    expect(tableFound).toBe(true)

    let breakState = EditorState.create({ doc: parsed.doc })
    breakState = breakState.apply(breakState.tr.setSelection(TextSelection.create(breakState.doc, 3)))
    breakState = run(createEditorCommands().insertHardBreak, breakState)
    expect(breakState.doc.firstChild?.child(1).type).toBe(strataSchema.nodes.hard_break)

    let ruleState = EditorState.create({ doc: parsed.doc })
    ruleState = run(createEditorCommands().insertHorizontalRule, ruleState)
    expect(ruleState.doc.firstChild?.type).toBe(strataSchema.nodes.horizontal_rule)
  })

  it('provides practical controls for list spacing, soft breaks, indented code, and images', () => {
    const list = parseMarkdownForEditor('- first\n- second\n')
    let listState = EditorState.create({ doc: list.doc })
    listState = run(createEditorCommands().setListTight(false), listState)
    expect(listState.doc.firstChild?.attrs.tight).toBe(false)

    const paragraph = parseMarkdownForEditor('Text\n')
    let softBreakState = EditorState.create({ doc: paragraph.doc })
    softBreakState = softBreakState.apply(softBreakState.tr.setSelection(TextSelection.create(softBreakState.doc, 3)))
    softBreakState = run(createEditorCommands().insertSoftBreak, softBreakState)
    expect(softBreakState.doc.firstChild?.child(1).type).toBe(strataSchema.nodes.soft_break)

    let codeState = EditorState.create({ doc: paragraph.doc })
    codeState = run(createEditorCommands().setIndentedCodeBlock, codeState)
    expect(codeState.doc.firstChild?.type).toBe(strataSchema.nodes.code_block)
    expect(codeState.doc.firstChild?.attrs).toEqual(expect.objectContaining({ fenced: false, indent: true }))

    const image = parseMarkdownForEditor('![old](before.png)\n')
    let imageState = EditorState.create({ doc: image.doc })
    imageState = imageState.apply(imageState.tr.setSelection(NodeSelection.create(imageState.doc, 1)))
    imageState = run(createEditorCommands().updateSelectedImage({ src: 'after.png', alt: 'new' }), imageState)
    expect(imageState.doc.firstChild?.firstChild?.attrs).toEqual(expect.objectContaining({
      src: 'after.png',
      alt: 'new',
    }))
  })

  it('nests and outdents list items through commands and Tab fallbacks', () => {
    const parsed = parseMarkdownForEditor('- first\n- second\n')
    let second = -1
    parsed.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'second') second = pos
    })
    let state = EditorState.create({ doc: parsed.doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, second)))
    state = run(createEditorKeymap().Tab!, state)
    expect(state.doc.firstChild?.firstChild?.lastChild?.type).toBe(strataSchema.nodes.bullet_list)

    state = run(createEditorKeymap()['Shift-Tab']!, state)
    expect(state.doc.firstChild?.childCount).toBe(2)
  })

  it('creates and removes autolinks and exposes every table operation', () => {
    const parsed = parseMarkdownForEditor('https://example.com\n')
    let state = EditorState.create({ doc: parsed.doc })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 20)))
    state = run(createEditorCommands().setAutolink(), state)
    expect(state.doc.rangeHasMark(1, 20, strataSchema.marks.link)).toBe(true)
    state = run(createEditorCommands().removeLink, state)
    expect(state.doc.rangeHasMark(1, 20, strataSchema.marks.link)).toBe(false)

    expect(Object.keys(createEditorCommands().table).sort()).toEqual([
      'addColumnAfter', 'addColumnBefore', 'addRowAfter', 'addRowBefore',
      'deleteColumn', 'deleteRow', 'deleteTable', 'mergeCells', 'splitCell',
      'toggleHeaderColumn', 'toggleHeaderRow',
    ])

    const table = parseMarkdownForEditor('| A | B |\n| --- | --- |\n| C | D |\n')
    const cells: number[] = []
    table.doc.descendants((node, pos) => {
      if (node.type === strataSchema.nodes.table_cell) cells.push(pos)
    })
    let tableState = EditorState.create({ doc: table.doc })
    tableState = tableState.apply(tableState.tr.setSelection(CellSelection.create(tableState.doc, cells[0]!, cells[1]!)))
    tableState = run(createEditorCommands().table.mergeCells, tableState)
    expect(tableState.doc.firstChild?.lastChild?.childCount).toBe(1)
    tableState = run(createEditorCommands().table.splitCell, tableState)
    expect(tableState.doc.firstChild?.lastChild?.childCount).toBe(2)
  })

  it('serializes the secondary toolbar commands as CommonMark and GFM', () => {
    const link = parseMarkdownForEditor('https\\://example.com\n')
    let linkState = EditorState.create({ doc: link.doc })
    linkState = linkState.apply(linkState.tr.setSelection(TextSelection.create(linkState.doc, 1, 20)))
    linkState = run(createEditorCommands().setAutolink(), linkState)
    expect(serializeEditorDocument(link, linkState.doc)).toBe('<https://example.com>\n')

    const list = parseMarkdownForEditor('- first\n- second\n')
    let listState = EditorState.create({ doc: list.doc })
    listState = run(createEditorCommands().setListTight(false), listState)
    expect(serializeEditorDocument(list, listState.doc)).toBe('- first\n\n- second\n')

    const paragraph = parseMarkdownForEditor('Text\n')
    let breakState = EditorState.create({ doc: paragraph.doc })
    breakState = breakState.apply(breakState.tr.setSelection(TextSelection.create(breakState.doc, 3)))
    breakState = run(createEditorCommands().insertSoftBreak, breakState)
    expect(serializeEditorDocument(paragraph, breakState.doc)).toBe('Te\nxt\n')

    let codeState = EditorState.create({ doc: paragraph.doc })
    codeState = run(createEditorCommands().setIndentedCodeBlock, codeState)
    expect(serializeEditorDocument(paragraph, codeState.doc)).toBe('    Text\n')
  })

  it('keeps every extended command reachable from an existing toolbar icon', () => {
    const commands = Object.values(toolbarMenuItems).flatMap((items) => items ?? []).map((item) => item.command)
    const required: EditorCommand[] = [
      'list-tight', 'list-loose', 'list-indent', 'list-outdent', 'soft-break',
      'indented-code-block', 'image-update', 'link-autolink', 'link-remove',
      'table-column-before', 'table-column-after', 'table-column-delete',
      'table-row-before', 'table-row-after', 'table-row-delete', 'table-delete',
      'table-merge-cells', 'table-split-cell', 'table-toggle-header-row',
      'table-toggle-header-column',
    ]
    expect(commands).toEqual(expect.arrayContaining(required))
  })

  it('never treats remote or executable image URLs as local', () => {
    expect(isLocalImageSource('./images/chart.png')).toBe(true)
    expect(isLocalImageSource('/tmp/chart.png')).toBe(true)
    expect(isLocalImageSource('https://example.com/chart.png')).toBe(false)
    expect(isLocalImageSource('//example.com/chart.png')).toBe(false)
    expect(isLocalImageSource('javascript:alert(1)')).toBe(false)
    expect(isLocalImageSource('data:image/png;base64,AA==')).toBe(false)
  })
})

describe('link and image popover placement (usability round 2 §2.8)', () => {
  it('sits below the selection when there is room and above it otherwise, inside the window', () => {
    const size = { width: 340, height: 160 }
    const viewport = { width: 1200, height: 800 }
    expect(popoverPosition({ left: 100, top: 200, bottom: 224 }, size, viewport)).toEqual({ left: 100, top: 232 })
    expect(popoverPosition({ left: 1100, top: 700, bottom: 724 }, size, viewport)).toEqual({ left: 852, top: 532 })
    expect(popoverPosition({ left: -40, top: 2, bottom: 20 }, size, viewport)).toEqual({ left: 8, top: 28 })
  })
})

describe('toolbar menus and the annotate pill (usability round 2 §5.1, §5.13)', () => {
  it('walks menu items with the arrow keys and wraps', () => {
    expect(menuItemAfter(3, 0, 'ArrowDown')).toBe(1)
    expect(menuItemAfter(3, 2, 'ArrowDown')).toBe(0)
    expect(menuItemAfter(3, 0, 'ArrowUp')).toBe(2)
    expect(menuItemAfter(3, -1, 'ArrowUp')).toBe(2)
    expect(menuItemAfter(3, 1, 'Home')).toBe(0)
    expect(menuItemAfter(3, 1, 'End')).toBe(2)
    expect(menuItemAfter(3, 1, 'Enter')).toBeNull()
    expect(menuItemAfter(0, -1, 'ArrowDown')).toBeNull()
  })

  it('explains why formatting is off in plain words', () => {
    expect(toolbarDisabledHint(false, false)).toBeNull()
    expect(toolbarDisabledHint(true, false)).toMatch(/visual view/)
    expect(toolbarDisabledHint(true, true)).toBe('This document is read-only')
  })

  it('lets bare C, Q, and S act only on pointer selections or a focused pill', () => {
    expect(bareHotkeysApply(null, false)).toBe(false)
    expect(bareHotkeysApply({ pointer: true }, false)).toBe(true)
    expect(bareHotkeysApply({}, false)).toBe(true)
    expect(bareHotkeysApply({ pointer: false }, false)).toBe(false)
    expect(bareHotkeysApply({ pointer: false }, true)).toBe(true)
  })
})
