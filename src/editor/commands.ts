import {
  baseKeymap,
  chainCommands,
  lift,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands'
import { Fragment, Slice, type Attrs, type NodeType, type Schema } from 'prosemirror-model'
import { NodeSelection, Selection, type Command, type EditorState, type Transaction } from 'prosemirror-state'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  mergeCells,
  splitCell,
  toggleHeaderColumn,
  toggleHeaderRow,
} from 'prosemirror-tables'
import { canSplit, ReplaceAroundStep } from 'prosemirror-transform'
import {
  strataSchema,
  type StrataMarkName,
  type StrataNodeName,
} from './schema'

export type EditorSchema = Schema<StrataNodeName, StrataMarkName>

const sourceAttributes = (attrs: Attrs): Attrs => ({
  sourceId: attrs.sourceId ?? null,
  sourceFrom: attrs.sourceFrom ?? null,
  sourceTo: attrs.sourceTo ?? null,
})

function ancestorDepth(state: EditorState, types: readonly NodeType[]): number | null {
  const { $from, $to } = state.selection
  for (let depth = Math.min($from.depth, $to.depth); depth > 0; depth -= 1) {
    const fromNode = $from.node(depth)
    if (fromNode === $to.node(depth) && types.includes(fromNode.type)) return depth
  }
  return null
}

function setTextblockType(type: NodeType, attrs: Attrs = {}): Command {
  return (state, dispatch) => {
    const positions = new Map<number, { nodeAttrs: Attrs; size: number }>()
    for (const range of state.selection.ranges) {
      state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
        if (!node.isTextblock) return true
        positions.set(pos, { nodeAttrs: node.attrs, size: node.nodeSize })
        return false
      })
    }
    if (positions.size === 0) return false

    const tr = state.tr
    for (const [pos, block] of positions) {
      tr.setBlockType(
        pos,
        pos + block.size,
        type,
        { ...sourceAttributes(block.nodeAttrs), ...attrs },
      )
    }
    if (!tr.docChanged) return false
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

function toggleWrap(type: NodeType): Command {
  return (state, dispatch, view) => {
    if (ancestorDepth(state, [type]) !== null) return lift(state, dispatch, view)
    return wrapIn(type)(state, dispatch, view)
  }
}

function defaultListAttrs(type: NodeType): Attrs {
  return type.name === 'ordered_list'
    ? { order: 1, marker: '.', delimiter: '.', tight: true }
    : { marker: '-', tight: true }
}

function toggleList(schema: EditorSchema, type: NodeType): Command {
  return (state, dispatch, view) => {
    const listTypes = [schema.nodes.bullet_list, schema.nodes.ordered_list]
    const depth = ancestorDepth(state, listTypes)
    if (depth === null) {
      const wrap = wrapIn(type, defaultListAttrs(type))
      if (wrap(state)) return wrap(state, dispatch, view)

      // A heading or code block cannot be the first child of list_item. Match
      // common Markdown editors by turning selected textblocks into paragraphs
      // before applying the list wrapper in the same undoable transaction.
      const normalizeTransactions: Transaction[] = []
      if (!setTextblockType(schema.nodes.paragraph)(state, (tr) => { normalizeTransactions.push(tr) })) return false
      const normalizeTransaction = normalizeTransactions[0]
      if (normalizeTransaction === undefined) return false
      const normalized = state.apply(normalizeTransaction)
      const wrapTransactions: Transaction[] = []
      if (!wrap(normalized, (tr) => { wrapTransactions.push(tr) }, view)) return false
      const wrapTransaction = wrapTransactions[0]
      if (wrapTransaction === undefined) return false
      if (!dispatch) return true

      const combined = state.tr
      for (const step of normalizeTransaction.steps) combined.step(step)
      for (const step of wrapTransaction.steps) combined.step(step)
      combined.setSelection(Selection.fromJSON(combined.doc, wrapTransaction.selection.toJSON()))
      dispatch(combined.scrollIntoView())
      return true
    }

    const current = state.selection.$from.node(depth)
    if (current.type === type) return lift(state, dispatch, view)

    if (!dispatch) return true
    const pos = state.selection.$from.before(depth)
    dispatch(state.tr.setNodeMarkup(pos, type, {
      ...sourceAttributes(current.attrs),
      ...defaultListAttrs(type),
      tight: current.attrs.tight ?? true,
    }).scrollIntoView())
    return true
  }
}

function setListTight(schema: EditorSchema, tight?: boolean): Command {
  return (state, dispatch) => {
    const depth = ancestorDepth(state, [schema.nodes.bullet_list, schema.nodes.ordered_list])
    if (depth === null) return false
    const list = state.selection.$from.node(depth)
    const next = tight ?? list.attrs.tight !== true
    dispatch?.(state.tr.setNodeMarkup(state.selection.$from.before(depth), undefined, {
      ...list.attrs,
      tight: next,
    }).scrollIntoView())
    return true
  }
}

function sinkListItem(schema: EditorSchema): Command {
  return (state, dispatch) => {
    const itemType = schema.nodes.list_item
    const { $from, $to } = state.selection
    const range = $from.blockRange($to, (node) => node.childCount > 0 && node.firstChild?.type === itemType)
    if (!range || range.startIndex === 0) return false
    const parent = range.parent
    const nodeBefore = parent.child(range.startIndex - 1)
    if (nodeBefore.type !== itemType) return false
    if (!dispatch) return true

    const nestedBefore = nodeBefore.lastChild?.type === parent.type
    const inner = Fragment.from(nestedBefore ? itemType.create() : null)
    const slice = new Slice(Fragment.from(itemType.create(
      null,
      Fragment.from(parent.type.create(null, inner)),
    )), nestedBefore ? 3 : 1, 0)
    const before = range.start
    const after = range.end
    dispatch(state.tr.step(new ReplaceAroundStep(
      before - (nestedBefore ? 3 : 1),
      after,
      before,
      after,
      slice,
      1,
      true,
    )).scrollIntoView())
    return true
  }
}

function liftListItem(schema: EditorSchema): Command {
  return (state, dispatch, view) => {
    const itemType = schema.nodes.list_item
    const listTypes = [schema.nodes.bullet_list, schema.nodes.ordered_list]
    const itemDepth = ancestorDepth(state, [itemType])
    if (itemDepth === null) return false
    const parentListDepth = itemDepth - 1
    const outerItemDepth = itemDepth - 2
    const outerListDepth = itemDepth - 3
    if (
      parentListDepth <= 0
      || !listTypes.includes(state.selection.$from.node(parentListDepth).type)
      || outerItemDepth <= 0
      || state.selection.$from.node(outerItemDepth).type !== itemType
      || outerListDepth <= 0
      || !listTypes.includes(state.selection.$from.node(outerListDepth).type)
    ) {
      return lift(state, dispatch, view)
    }
    if (!dispatch) return true

    const $from = state.selection.$from
    const innerList = $from.node(parentListDepth)
    const innerItemIndex = $from.index(parentListDepth)
    const movedItem = innerList.child(innerItemIndex)
    const remainingInnerItems = innerList.content.content.filter((_node, index) => index !== innerItemIndex)
    const outerItem = $from.node(outerItemDepth)
    const innerListIndex = $from.index(outerItemDepth)
    const outerItemChildren = [...outerItem.content.content]
    if (remainingInnerItems.length === 0) outerItemChildren.splice(innerListIndex, 1)
    else outerItemChildren[innerListIndex] = innerList.copy(Fragment.fromArray(remainingInnerItems))
    const updatedOuterItem = outerItem.copy(Fragment.fromArray(outerItemChildren))

    const outerList = $from.node(outerListDepth)
    const outerItemIndex = $from.index(outerListDepth)
    const outerChildren = [...outerList.content.content]
    outerChildren.splice(outerItemIndex, 1, updatedOuterItem, movedItem)
    const updatedOuterList = outerList.copy(Fragment.fromArray(outerChildren))
    const outerListPos = $from.before(outerListDepth)
    const insertedItemPos = outerListPos + 1
      + outerChildren.slice(0, outerItemIndex + 1).reduce((size, node) => size + node.nodeSize, 0)
    const transaction = state.tr.replaceWith(
      outerListPos,
      outerListPos + outerList.nodeSize,
      updatedOuterList,
    )
    transaction.setSelection(Selection.near(transaction.doc.resolve(
      Math.min(transaction.doc.content.size, insertedItemPos + 2),
    )))
    dispatch(transaction.scrollIntoView())
    return true
  }
}

/** Split a normal list item at the cursor. Empty items fall through to lift. */
export function splitListItem(schema: EditorSchema = strataSchema): Command {
  return (state, dispatch, view) => {
    const itemType = schema.nodes.list_item
    const { $from, $to } = state.selection
    const depth = ancestorDepth(state, [itemType])
    if (depth === null || $from.depth <= depth || $to.depth <= depth) return false

    if ($from.parent.content.size === 0) return lift(state, dispatch, view)

    const tr = state.tr.delete($from.pos, $to.pos)
    const splitPos = tr.mapping.map($from.pos)
    const itemAttrs = {
      ...sourceAttributes($from.node(depth).attrs),
      sourceId: null,
      sourceFrom: null,
      sourceTo: null,
      checked: null,
      spread: $from.node(depth).attrs.spread ?? false,
    }
    const paragraphAttrs = { sourceId: null, sourceFrom: null, sourceTo: null }
    const typesAfter = [{ type: itemType, attrs: itemAttrs }, { type: $from.parent.type, attrs: paragraphAttrs }]
    if (!canSplit(tr.doc, splitPos, 2, typesAfter)) return false
    dispatch?.(tr.split(splitPos, 2, typesAfter).scrollIntoView())
    return true
  }
}

function setTaskChecked(schema: EditorSchema, checked?: boolean): Command {
  return (state, dispatch) => {
    const depth = ancestorDepth(state, [schema.nodes.list_item])
    if (depth === null) return false
    const item = state.selection.$from.node(depth)
    const next = checked ?? item.attrs.checked !== true
    dispatch?.(state.tr.setNodeMarkup(state.selection.$from.before(depth), undefined, {
      ...item.attrs,
      checked: next,
    }))
    return true
  }
}

function toggleTaskList(schema: EditorSchema): Command {
  return (state, dispatch, view) => {
    const itemDepth = ancestorDepth(state, [schema.nodes.list_item])
    if (itemDepth !== null) {
      const item = state.selection.$from.node(itemDepth)
      const checked = typeof item.attrs.checked === 'boolean' ? null : false
      dispatch?.(state.tr.setNodeMarkup(state.selection.$from.before(itemDepth), undefined, {
        ...item.attrs,
        checked,
      }))
      return true
    }

    const listTransactions: Transaction[] = []
    if (!toggleList(schema, schema.nodes.bullet_list)(state, (tr) => { listTransactions.push(tr) }, view)) {
      return false
    }
    const listTransaction = listTransactions[0]
    if (listTransaction === undefined) return false
    const listed = state.apply(listTransaction)
    const taskTransactions: Transaction[] = []
    if (!setTaskChecked(schema, false)(listed, (tr) => { taskTransactions.push(tr) })) return false
    const taskTransaction = taskTransactions[0]
    if (taskTransaction === undefined) return false
    if (!dispatch) return true

    const combined = state.tr
    for (const step of listTransaction.steps) combined.step(step)
    for (const step of taskTransaction.steps) combined.step(step)
    combined.setSelection(Selection.fromJSON(combined.doc, taskTransaction.selection.toJSON()))
    dispatch(combined.scrollIntoView())
    return true
  }
}

function setLink(schema: EditorSchema, href: string, title: string | null = null): Command {
  return (state, dispatch) => {
    const mark = schema.marks.link.create({ href, title, autolink: false, reference: null })
    const { from, to, empty } = state.selection
    if (!dispatch) return true
    if (empty) {
      dispatch(state.tr.addStoredMark(mark))
      return true
    }
    dispatch(state.tr.removeMark(from, to, schema.marks.link).addMark(from, to, mark).scrollIntoView())
    return true
  }
}

function setAutolink(schema: EditorSchema, href?: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const visible = empty ? '' : state.doc.textBetween(from, to, '', '')
    const target = href?.trim() || visible.trim()
    if (!target || empty) return false
    const linkHref = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(target) ? `mailto:${target}` : target
    if (!/^(?:https?:\/\/|mailto:)/iu.test(linkHref)) return false
    dispatch?.(state.tr
      .removeMark(from, to, schema.marks.link)
      // Escaped source spelling is not valid inside an angle autolink. Once
      // the user explicitly chooses autolink, serialize the decoded target.
      .removeMark(from, to, schema.marks.source_token)
      .addMark(from, to, schema.marks.link.create({
        href: linkHref,
        title: null,
        autolink: true,
        reference: null,
      }))
      .scrollIntoView())
    return true
  }
}

function removeLink(schema: EditorSchema): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) {
      const active = state.storedMarks ?? state.selection.$from.marks()
      if (!active.some((mark) => mark.type === schema.marks.link)) return false
      dispatch?.(state.tr.removeStoredMark(schema.marks.link))
      return true
    }
    if (!state.doc.rangeHasMark(from, to, schema.marks.link)) return false
    dispatch?.(state.tr.removeMark(from, to, schema.marks.link).scrollIntoView())
    return true
  }
}

export interface InsertImageAttrs {
  src: string
  alt?: string | null
  title?: string | null
  reference?: string | null
}

function insertImage(schema: EditorSchema, attrs: InsertImageAttrs): Command {
  return (state, dispatch) => {
    const image = schema.nodes.image.create({
      src: attrs.src,
      alt: attrs.alt ?? null,
      title: attrs.title ?? null,
      reference: attrs.reference ?? null,
    })
    if (!state.selection.$from.parent.canReplaceWith(
      state.selection.$from.index(),
      state.selection.$to.indexAfter(),
      image.type,
    )) return false
    dispatch?.(state.tr.replaceSelectionWith(image).scrollIntoView())
    return true
  }
}

function updateSelectedImage(schema: EditorSchema, attrs: Partial<InsertImageAttrs>): Command {
  return (state, dispatch) => {
    const selection = state.selection
    if (!(selection instanceof NodeSelection) || selection.node.type !== schema.nodes.image) return false
    dispatch?.(state.tr.setNodeMarkup(selection.from, undefined, {
      ...selection.node.attrs,
      ...attrs,
    }).scrollIntoView())
    return true
  }
}

export interface InsertTableOptions {
  rows?: number
  columns?: number
  header?: boolean
  align?: Array<'left' | 'center' | 'right' | null>
}

function insertTable(schema: EditorSchema, options: InsertTableOptions = {}): Command {
  return (state, dispatch) => {
    const rows = Math.max(1, Math.trunc(options.rows ?? 2))
    const columns = Math.max(1, Math.trunc(options.columns ?? 2))
    const align = Array.from({ length: columns }, (_, index) => options.align?.[index] ?? null)
    const tableRows = Array.from({ length: rows }, (_, rowIndex) => {
      const cellType = options.header !== false && rowIndex === 0
        ? schema.nodes.table_header
        : schema.nodes.table_cell
      const cells = Array.from({ length: columns }, (_, columnIndex) => cellType.create(
        { align: align[columnIndex] ?? null },
        schema.nodes.paragraph.create(),
      ))
      return schema.nodes.table_row.create(null, cells)
    })
    const table = schema.nodes.table.create({
      sourceId: null,
      sourceFrom: null,
      sourceTo: null,
      align,
    }, tableRows)
    dispatch?.(state.tr.replaceSelectionWith(table).scrollIntoView())
    return true
  }
}

export interface StrataEditorCommands {
  toggleStrong: Command
  toggleEmphasis: Command
  toggleStrikethrough: Command
  toggleInlineCode: Command
  setParagraph: Command
  setHeading(level: 1 | 2 | 3 | 4 | 5 | 6): Command
  toggleBlockquote: Command
  setCodeBlock: Command
  toggleBulletList: Command
  toggleOrderedList: Command
  setListTight(tight?: boolean): Command
  sinkListItem: Command
  liftListItem: Command
  toggleTaskList: Command
  splitListItem: Command
  setTaskChecked(checked?: boolean): Command
  setLink(href: string, title?: string | null): Command
  setAutolink(href?: string): Command
  removeLink: Command
  insertImage(attrs: InsertImageAttrs): Command
  updateSelectedImage(attrs: Partial<InsertImageAttrs>): Command
  insertHorizontalRule: Command
  insertHardBreak: Command
  insertSoftBreak: Command
  setIndentedCodeBlock: Command
  insertTable(options?: InsertTableOptions): Command
  table: {
    addColumnBefore: Command
    addColumnAfter: Command
    deleteColumn: Command
    addRowBefore: Command
    addRowAfter: Command
    deleteRow: Command
    deleteTable: Command
    mergeCells: Command
    splitCell: Command
    toggleHeaderRow: Command
    toggleHeaderColumn: Command
  }
}

export function createEditorCommands(schema: EditorSchema = strataSchema): StrataEditorCommands {
  return {
    toggleStrong: toggleMark(schema.marks.strong, null, { removeWhenPresent: false }),
    toggleEmphasis: toggleMark(schema.marks.em, null, { removeWhenPresent: false }),
    toggleStrikethrough: toggleMark(schema.marks.strike, null, { removeWhenPresent: false }),
    toggleInlineCode: toggleMark(schema.marks.code, null, { removeWhenPresent: false }),
    setParagraph: setTextblockType(schema.nodes.paragraph),
    setHeading: (level) => setTextblockType(schema.nodes.heading, { level, style: 'atx' }),
    toggleBlockquote: toggleWrap(schema.nodes.blockquote),
    setCodeBlock: setTextblockType(schema.nodes.code_block, {
      fenced: true,
      fence: '`',
      info: null,
      meta: null,
      indent: false,
    }),
    toggleBulletList: toggleList(schema, schema.nodes.bullet_list),
    toggleOrderedList: toggleList(schema, schema.nodes.ordered_list),
    setListTight: (tight) => setListTight(schema, tight),
    sinkListItem: sinkListItem(schema),
    liftListItem: liftListItem(schema),
    toggleTaskList: toggleTaskList(schema),
    splitListItem: splitListItem(schema),
    setTaskChecked: (checked) => setTaskChecked(schema, checked),
    setLink: (href, title = null) => setLink(schema, href, title),
    setAutolink: (href) => setAutolink(schema, href),
    removeLink: removeLink(schema),
    insertImage: (attrs) => insertImage(schema, attrs),
    updateSelectedImage: (attrs) => updateSelectedImage(schema, attrs),
    insertHorizontalRule: (state, dispatch) => {
      const rule = schema.nodes.horizontal_rule.create()
      dispatch?.(state.tr.replaceSelectionWith(rule).scrollIntoView())
      return true
    },
    insertHardBreak: (state, dispatch) => {
      const hardBreak = schema.nodes.hard_break.create()
      dispatch?.(state.tr.replaceSelectionWith(hardBreak).scrollIntoView())
      return true
    },
    insertSoftBreak: (state, dispatch) => {
      const softBreak = schema.nodes.soft_break.create()
      dispatch?.(state.tr.replaceSelectionWith(softBreak).scrollIntoView())
      return true
    },
    setIndentedCodeBlock: setTextblockType(schema.nodes.code_block, {
      fenced: false,
      fence: null,
      info: null,
      meta: null,
      indent: true,
    }),
    insertTable: (options) => insertTable(schema, options),
    table: {
      addColumnBefore,
      addColumnAfter,
      deleteColumn,
      addRowBefore,
      addRowAfter,
      deleteRow,
      deleteTable,
      mergeCells,
      splitCell,
      toggleHeaderRow,
      toggleHeaderColumn,
    },
  }
}

export interface EditorKeymapCallbacks {
  save?: () => unknown
  send?: () => unknown
  toggleSource?: () => unknown
  editLink?: () => unknown
  /** Editor-owned undo and redo; they walk one timeline of local and application steps. */
  undo?: () => unknown
  redo?: () => unknown
}

function callbackCommand(callback: (() => unknown) | undefined): Command {
  return (_state, dispatch) => {
    if (callback === undefined) return false
    if (dispatch !== undefined) void callback()
    return true
  }
}

/**
 * Complete Linux keymap for one editor view. Callers may pass the result
 * directly to prosemirror-keymap's keymap().
 */
export function createEditorKeymap(
  callbacks: EditorKeymapCallbacks = {},
  schema: EditorSchema = strataSchema,
): Record<string, Command> {
  const commands = createEditorCommands(schema)
  return {
    ...baseKeymap,
    Enter: chainCommands(commands.splitListItem, baseKeymap.Enter!),
    Tab: chainCommands(goToNextCell(1), commands.sinkListItem),
    'Shift-Tab': chainCommands(goToNextCell(-1), commands.liftListItem),
    'Ctrl-b': commands.toggleStrong,
    'Ctrl-i': commands.toggleEmphasis,
    'Ctrl-k': callbackCommand(callbacks.editLink),
    'Shift-Ctrl-c': commands.toggleInlineCode,
    'Ctrl-0': commands.setParagraph,
    'Ctrl-1': commands.setHeading(1),
    'Ctrl-2': commands.setHeading(2),
    'Ctrl-3': commands.setHeading(3),
    'Ctrl-4': commands.setHeading(4),
    'Ctrl-5': commands.setHeading(5),
    'Ctrl-6': commands.setHeading(6),
    'Shift-Ctrl-7': commands.toggleOrderedList,
    'Shift-Ctrl-8': commands.toggleBulletList,
    'Shift-Enter': commands.insertHardBreak,
    'Ctrl-s': callbackCommand(callbacks.save),
    'Ctrl-Enter': callbackCommand(callbacks.send),
    'Ctrl-/': callbackCommand(callbacks.toggleSource),
    'Ctrl-z': callbackCommand(callbacks.undo),
    'Shift-Ctrl-z': callbackCommand(callbacks.redo),
    'Ctrl-y': callbackCommand(callbacks.redo),
  }
}

/** Update a rendered task checkbox without letting the DOM become state. */
export function handleTaskCheckboxClick(
  schema: EditorSchema,
  view: { posAtDOM(node: Node, offset: number): number; state: EditorState; dispatch: (tr: EditorState['tr']) => void },
  event: MouseEvent,
): boolean {
  const target = event.target
  const checkbox = target instanceof Element
    ? target.closest<HTMLElement>('[data-task-checkbox="true"]')
    : null
  if (!checkbox) return false
  event.preventDefault()

  const pos = view.posAtDOM(checkbox, 0)
  const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size))
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const item = $pos.node(depth)
    if (item.type !== schema.nodes.list_item) continue
    view.dispatch(view.state.tr.setNodeMarkup($pos.before(depth), undefined, {
      ...item.attrs,
      checked: item.attrs.checked !== true,
    }))
    return true
  }
  return false
}
