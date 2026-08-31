import {
  Schema,
  type DOMOutputSpec,
  type MarkSpec,
  type NodeSpec,
} from 'prosemirror-model'

export const sourceAttrs = {
  sourceId: { default: null },
  sourceFrom: { default: null },
  sourceTo: { default: null },
} as const

/** Count top-level YAML mapping keys for the collapsed frontmatter chip. */
export function frontmatterKeyCount(raw: string): number {
  return raw
    .replace(/^\ufeff/u, '')
    .split(/\r?\n/u)
    .filter((line) => /^(?:"[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*:/u.test(line))
    .length
}

export function frontmatterChipLabel(raw: string): string {
  const count = frontmatterKeyCount(raw)
  return `▸ --- frontmatter · ${count} ${count === 1 ? 'key' : 'keys'} ---`
}

const safeLinkHref = (href: unknown): string | undefined => {
  if (typeof href !== 'string' || href.length === 0) return undefined
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1]?.toLowerCase()
  if (scheme !== undefined && !['http', 'https', 'mailto'].includes(scheme)) return undefined
  return href
}

const sourceDomAttrs = (attrs: Readonly<Record<string, unknown>>): Record<string, string> => {
  const result: Record<string, string> = {}
  if (typeof attrs.sourceId === 'string') result['data-source-id'] = attrs.sourceId
  return result
}

const textBlockAttrs = (dom: HTMLElement): Record<string, string | number | null> => ({
  sourceId: dom.dataset.sourceId ?? null,
  sourceFrom: null,
  sourceTo: null,
})

const taskItemAttrs = (dom: HTMLElement): Record<string, string | number | boolean | null> => {
  const checkbox = dom.querySelector<HTMLElement>(':scope > [data-task-checkbox], :scope > input[type="checkbox"]')
  const checked = checkbox instanceof HTMLInputElement
    ? checkbox.checked
    : checkbox?.getAttribute('aria-checked') === 'true' || checkbox?.dataset.checked === 'true'
  return {
    ...textBlockAttrs(dom),
    checked: checkbox ? checked : null,
  }
}

const cellAlign = (dom: HTMLElement): 'left' | 'center' | 'right' | null => {
  const value = dom.getAttribute('align') ?? dom.style.textAlign
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}

const tableCellAttrs = (dom: HTMLElement): Record<string, unknown> => ({
  colspan: Number.parseInt(dom.getAttribute('colspan') ?? '1', 10),
  rowspan: Number.parseInt(dom.getAttribute('rowspan') ?? '1', 10),
  colwidth: dom.dataset.colwidth?.split(',').map(Number).filter(Number.isFinite) ?? null,
  align: cellAlign(dom),
})

const tableCellDomAttrs = (attrs: Readonly<Record<string, unknown>>): Record<string, string> => ({
  ...(Number(attrs.colspan) > 1 ? { colspan: String(attrs.colspan) } : {}),
  ...(Number(attrs.rowspan) > 1 ? { rowspan: String(attrs.rowspan) } : {}),
  ...(Array.isArray(attrs.colwidth) ? { 'data-colwidth': attrs.colwidth.join(',') } : {}),
  ...(attrs.align === 'left' || attrs.align === 'center' || attrs.align === 'right'
    ? { style: `text-align: ${attrs.align}` }
    : {}),
})

const nodes = {
  doc: { content: 'block+' },

  text: { group: 'inline' },

  paragraph: {
    attrs: sourceAttrs,
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p', getAttrs: textBlockAttrs }],
    toDOM: (node): DOMOutputSpec => ['p', sourceDomAttrs(node.attrs), 0],
  },

  heading: {
    attrs: {
      ...sourceAttrs,
      level: { default: 1, validate: 'number' },
      style: { default: 'atx', validate: 'string' },
    },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      getAttrs: (dom: HTMLElement) => ({ ...textBlockAttrs(dom), level, style: 'atx' }),
    })),
    toDOM: (node): DOMOutputSpec => [
      `h${Math.min(6, Math.max(1, Number(node.attrs.level)))}`,
      sourceDomAttrs(node.attrs),
      0,
    ],
  },

  blockquote: {
    attrs: sourceAttrs,
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote', getAttrs: textBlockAttrs }],
    toDOM: (node): DOMOutputSpec => ['blockquote', sourceDomAttrs(node.attrs), 0],
  },

  horizontal_rule: {
    attrs: {
      ...sourceAttrs,
      markup: { default: '---', validate: 'string' },
    },
    group: 'block',
    parseDOM: [{ tag: 'hr', getAttrs: textBlockAttrs }],
    toDOM: (node): DOMOutputSpec => ['hr', sourceDomAttrs(node.attrs)],
  },

  code_block: {
    attrs: {
      ...sourceAttrs,
      fenced: { default: true, validate: 'boolean' },
      fence: { default: '`', validate: 'string|null' },
      info: { default: null, validate: 'string|null' },
      meta: { default: null, validate: 'string|null' },
      indent: { default: false, validate: 'boolean' },
    },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    isolating: true,
    parseDOM: [{
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => ({
        ...textBlockAttrs(dom),
        fenced: dom.dataset.fenced !== 'false',
        fence: dom.dataset.fence ?? '`',
        info: dom.dataset.info ?? null,
        meta: dom.dataset.meta ?? null,
        indent: dom.dataset.indent === 'true',
      }),
    }],
    toDOM: (node): DOMOutputSpec => [
      'pre',
      {
        ...sourceDomAttrs(node.attrs),
        'data-fenced': String(node.attrs.fenced),
        ...(typeof node.attrs.fence === 'string' ? { 'data-fence': node.attrs.fence } : {}),
        ...(typeof node.attrs.info === 'string' ? { 'data-info': node.attrs.info } : {}),
        ...(typeof node.attrs.meta === 'string' ? { 'data-meta': node.attrs.meta } : {}),
        'data-indent': String(node.attrs.indent),
        spellcheck: 'false',
      },
      ['code', 0],
    ],
  },

  raw_block: {
    attrs: {
      ...sourceAttrs,
      kind: { default: 'unsupported', validate: 'string' },
      raw: { default: '', validate: 'string' },
    },
    group: 'block',
    atom: true,
    selectable: true,
    isolating: true,
    parseDOM: [{
      tag: 'pre[data-strata-raw]',
      getAttrs: (dom: HTMLElement) => ({
        ...textBlockAttrs(dom),
        kind: dom.dataset.strataRaw ?? 'unsupported',
        raw: dom.textContent ?? '',
      }),
    }, {
      tag: 'details[data-strata-raw]',
      getAttrs: (dom: HTMLElement) => ({
        ...textBlockAttrs(dom),
        kind: dom.dataset.strataRaw ?? 'unsupported',
        raw: dom.querySelector('pre')?.textContent ?? '',
      }),
    }],
    toDOM: (node): DOMOutputSpec => {
      if (node.attrs.kind === 'yaml') {
        const raw = String(node.attrs.raw)
        const keyCount = frontmatterKeyCount(raw)
        return [
          'details',
          {
            ...sourceDomAttrs(node.attrs),
            'data-strata-raw': 'yaml',
            'data-frontmatter-key-count': String(keyCount),
            contenteditable: 'false',
            style: 'margin:0 0 24px',
          },
          [
            'summary',
            {
              'data-frontmatter-chip': 'true',
              title: 'YAML frontmatter — raw block, byte-preserved, editable in source view',
              style: "display:inline-block;list-style:none;border-radius:12px;padding:8px 16px;background:var(--surfaces-inset);color:var(--interface-muted);font-family:var(--font-code),'JetBrains Mono',monospace;font-size:13px;font-weight:500;cursor:pointer;transition:color .15s",
            },
            frontmatterChipLabel(raw),
          ],
          ['pre', { 'data-frontmatter-source': 'true' }, ['code', raw]],
        ]
      }
      return [
          'pre',
          {
            ...sourceDomAttrs(node.attrs),
            'data-strata-raw': String(node.attrs.kind),
            contenteditable: 'false',
          },
          ['code', String(node.attrs.raw)],
        ]
    },
  },

  bullet_list: {
    attrs: {
      ...sourceAttrs,
      marker: { default: '-', validate: 'string' },
      tight: { default: true, validate: 'boolean' },
    },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul', getAttrs: textBlockAttrs }],
    toDOM: (node): DOMOutputSpec => [
      'ul',
      { ...sourceDomAttrs(node.attrs), 'data-tight': String(node.attrs.tight) },
      0,
    ],
  },

  ordered_list: {
    attrs: {
      ...sourceAttrs,
      marker: { default: '1.', validate: 'string' },
      tight: { default: true, validate: 'boolean' },
      order: { default: 1, validate: 'number' },
      delimiter: { default: '.', validate: 'string' },
    },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{
      tag: 'ol',
      getAttrs: (dom: HTMLElement) => ({
        ...textBlockAttrs(dom),
        marker: `${dom.getAttribute('start') ?? '1'}.`,
        tight: dom.dataset.tight !== 'false',
        order: Number.parseInt(dom.getAttribute('start') ?? '1', 10),
        delimiter: '.',
      }),
    }],
    toDOM: (node): DOMOutputSpec => [
      'ol',
      {
        ...sourceDomAttrs(node.attrs),
        ...(node.attrs.order === 1 ? {} : { start: String(node.attrs.order) }),
        'data-tight': String(node.attrs.tight),
      },
      0,
    ],
  },

  list_item: {
    attrs: {
      ...sourceAttrs,
      checked: { default: null, validate: 'boolean|null' },
      spread: { default: false, validate: 'boolean' },
    },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li', getAttrs: taskItemAttrs }],
    toDOM: (node): DOMOutputSpec => {
      if (typeof node.attrs.checked !== 'boolean') {
        return ['li', sourceDomAttrs(node.attrs), 0]
      }
      return [
        'li',
        {
          ...sourceDomAttrs(node.attrs),
          'data-task-item': 'true',
          'data-task-checked': String(node.attrs.checked),
        },
        [
          'button',
          {
            type: 'button',
            'data-task-checkbox': 'true',
            'data-checked': String(node.attrs.checked),
            role: 'checkbox',
            'aria-checked': String(node.attrs.checked),
            'aria-label': node.attrs.checked ? 'Mark task incomplete' : 'Mark task complete',
            contenteditable: 'false',
            style: node.attrs.checked
              ? 'width:22px;height:22px;padding:0;border-radius:8px;border:0;background:var(--controls-positive);display:inline-grid;place-items:center;flex:none;margin-top:7px;cursor:pointer;font:inherit;box-shadow:0 4px 14px -3px color-mix(in srgb, var(--controls-positive) 50%, transparent);transition:all .2s cubic-bezier(.34,1.56,.64,1)'
              : 'width:22px;height:22px;padding:0;border-radius:8px;border:2.5px solid color-mix(in srgb, var(--surfaces-border) 60%, var(--controls-primary));background:transparent;display:inline-grid;place-items:center;flex:none;margin-top:7px;cursor:pointer;font:inherit;transition:all .2s cubic-bezier(.34,1.56,.64,1)',
          },
          ...(node.attrs.checked
            ? [[
                'span',
                {
                  'data-task-check-glyph': 'true',
                  style: 'color:var(--controls-positive-text);font-size:13px;font-weight:900;line-height:1;animation:checkPop .4s cubic-bezier(.34,1.56,.64,1)',
                },
                '✓',
              ] as DOMOutputSpec]
            : []),
        ],
        [
          'div',
          {
            'data-task-content': 'true',
            style: node.attrs.checked
              ? 'min-width:0;text-decoration:line-through;color:var(--interface-muted);transition:all .25s'
              : 'min-width:0;transition:all .25s',
          },
          0,
        ],
      ]
    },
  },

  table: {
    attrs: {
      ...sourceAttrs,
      align: { default: null },
    },
    content: 'table_row+',
    group: 'block',
    isolating: true,
    tableRole: 'table',
    parseDOM: [{
      tag: 'table',
      getAttrs: (dom: HTMLElement) => {
        const encoded = dom.dataset.align
        let align: unknown = null
        if (encoded !== undefined) {
          try {
            align = JSON.parse(encoded)
          } catch {
            align = null
          }
        }
        return { ...textBlockAttrs(dom), align }
      },
    }],
    toDOM: (node): DOMOutputSpec => [
      'table',
      {
        ...sourceDomAttrs(node.attrs),
        ...(Array.isArray(node.attrs.align)
          ? { 'data-align': JSON.stringify(node.attrs.align) }
          : {}),
      },
      ['tbody', 0],
    ],
  },

  table_row: {
    content: '(table_cell | table_header)+',
    tableRole: 'row',
    parseDOM: [{ tag: 'tr' }],
    toDOM: (): DOMOutputSpec => ['tr', 0],
  },

  table_cell: {
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
      align: { default: null },
    },
    content: 'block+',
    isolating: true,
    tableRole: 'cell',
    parseDOM: [{ tag: 'td', getAttrs: tableCellAttrs }],
    toDOM: (node): DOMOutputSpec => [
      'td',
      tableCellDomAttrs(node.attrs),
      0,
    ],
  },

  table_header: {
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
      align: { default: null },
    },
    content: 'block+',
    isolating: true,
    tableRole: 'header_cell',
    parseDOM: [{ tag: 'th', getAttrs: tableCellAttrs }],
    toDOM: (node): DOMOutputSpec => [
      'th',
      tableCellDomAttrs(node.attrs),
      0,
    ],
  },

  image: {
    attrs: {
      src: { default: '', validate: 'string' },
      alt: { default: null },
      title: { default: null },
      reference: { default: null },
    },
    group: 'inline',
    inline: true,
    atom: true,
    draggable: true,
    parseDOM: [
      {
        tag: 'span[data-strata-image]',
        getAttrs: (dom: HTMLElement) => ({
          src: dom.dataset.strataImage ?? '',
          alt: dom.getAttribute('aria-label'),
          title: dom.getAttribute('title'),
          reference: null,
        }),
      },
      {
        tag: 'img[src]',
        getAttrs: (dom: HTMLElement) => ({
          src: dom.getAttribute('src') ?? '',
          alt: dom.getAttribute('alt'),
          title: dom.getAttribute('title'),
          reference: null,
        }),
      },
    ],
    // The node view resolves local bytes. Keeping src off the DOM prevents the
    // browser from fetching a remote URL before that check runs.
    toDOM: (node): DOMOutputSpec => [
      'span',
      {
        'data-strata-image': String(node.attrs.src),
        'aria-label': typeof node.attrs.alt === 'string' ? node.attrs.alt : 'Image',
        ...(typeof node.attrs.title === 'string' ? { title: node.attrs.title } : {}),
      },
      'Image',
    ],
  },

  hard_break: {
    attrs: {
      /** Exact source spelling, including its line ending, when parsed from Markdown. */
      sourceRaw: { default: null, validate: 'string|null' },
    },
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br:not([data-soft-break])' }],
    toDOM: (): DOMOutputSpec => ['br'],
  },

  soft_break: {
    attrs: {
      /** Exact source line ending when parsed from Markdown. */
      sourceRaw: { default: null, validate: 'string|null' },
    },
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    parseDOM: [{ tag: 'span[data-soft-break]' }],
    toDOM: (): DOMOutputSpec => ['span', { 'data-soft-break': 'true' }, ' '],
  },
} satisfies Record<string, NodeSpec>

const marks = {
  /**
   * Retains the source spelling of one decoded entity or escaped character.
   * The serializer uses it only while the text still equals `decoded`, so an
   * edit to the token becomes ordinary Markdown instead of stale source.
   */
  source_token: {
    attrs: {
      raw: { validate: 'string' },
      decoded: { validate: 'string' },
    },
    inclusive: false,
    parseDOM: [{
      tag: 'span[data-strata-source-token]',
      getAttrs: (dom: HTMLElement) => ({
        raw: dom.dataset.strataSourceToken ?? '',
        decoded: dom.textContent ?? '',
      }),
    }],
    toDOM: (mark): DOMOutputSpec => [
      'span',
      { 'data-strata-source-token': String(mark.attrs.raw) },
      0,
    ],
  },

  em: {
    attrs: { delimiter: { default: null, validate: 'string|null' } },
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },

  strong: {
    attrs: { delimiter: { default: null, validate: 'string|null' } },
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom: HTMLElement) => dom.style.fontWeight !== 'normal' && null },
      { style: 'font-weight=400', clearMark: (mark) => mark.type.name === 'strong' },
      { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2})$/.test(String(value)) && null },
    ],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },

  strike: {
    attrs: { delimiter: { default: null, validate: 'string|null' } },
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },

  code: {
    attrs: { delimiter: { default: null, validate: 'string|null' } },
    code: true,
    excludes: '_',
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', { spellcheck: 'false' }, 0],
  },

  link: {
    attrs: {
      href: { validate: 'string' },
      title: { default: null },
      autolink: { default: false, validate: 'boolean' },
      reference: { default: null },
    },
    inclusive: false,
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom: HTMLElement) => ({
        href: dom.getAttribute('href') ?? '',
        title: dom.getAttribute('title'),
        autolink: false,
        reference: null,
      }),
    }],
    toDOM: (mark): DOMOutputSpec => {
      const href = safeLinkHref(mark.attrs.href)
      return [
        'a',
        {
          ...(href === undefined ? {} : { href }),
          ...(typeof mark.attrs.title === 'string' ? { title: mark.attrs.title } : {}),
          rel: 'noreferrer noopener',
        },
        0,
      ]
    },
  },
} satisfies Record<string, MarkSpec>

export type StrataNodeName = keyof typeof nodes
export type StrataMarkName = keyof typeof marks

export const strataSchema = new Schema<StrataNodeName, StrataMarkName>({ nodes, marks })

export type StrataSchema = typeof strataSchema
