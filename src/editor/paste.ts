import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from 'prosemirror-model'
import { parseMarkdownForEditor } from './markdown.js'

// Plain-text paste (usability round 2 §5.9): text that reads as markdown is
// parsed and inserted as structure; plain prose is inserted as typed.

const MARKDOWN_SIGNS: readonly RegExp[] = [
  /^#{1,6}\s\S/mu,
  /^\s*(?:[-*+]|\d+[.)])\s\S/mu,
  /^\s*[-*+]\s\[[ xX]\]\s/mu,
  /^```/mu,
  /^>\s?\S/mu,
  /^\|.+\|\s*$/mu,
  /^(?:-{3,}|\*{3,}|_{3,})\s*$/mu,
  /\*\*\S[\s\S]*?\S\*\*|__\S[\s\S]*?\S__/u,
  /(?:^|[^\w*])\*\S[^*\n]*?\S\*(?![\w*])/u,
  /(?:^|[^\w_])_\S[^_\n]*?\S_(?![\w_])/u,
  /~~\S[\s\S]*?\S~~/u,
  /`[^`\n]+`/u,
  /!?\[[^\]\n]+\]\([^)\n]+\)/u,
  /<https?:\/\/[^>\s]+>/u,
]

/** True when the text carries markdown syntax worth parsing; a plain sentence does not. */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_SIGNS.some((sign) => sign.test(text))
}

/**
 * Pasted nodes must not carry the parse's block identities: the serializer
 * matches top-level nodes to the open document's original blocks by sourceId,
 * and a pasted block-0 would steal the real one's byte-preserved source.
 */
export function stripSourceIdentity(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node
  const children: ProseMirrorNode[] = []
  node.forEach((child) => children.push(stripSourceIdentity(child)))
  const attrs = 'sourceId' in node.attrs
    ? { ...node.attrs, sourceId: null, sourceFrom: null, sourceTo: null }
    : node.attrs
  return node.type.create(attrs, Fragment.fromArray(children), node.marks)
}

/** The slice to insert for a markdown paste, open at both ends so paragraphs merge at the caret. */
export function markdownPasteSlice(text: string): Slice {
  const doc = stripSourceIdentity(parseMarkdownForEditor(text).doc)
  return new Slice(doc.content, 1, 1)
}

/**
 * ProseMirror's clipboardTextParser hook. Returns null to let the default
 * plain-text handling run: inside code, on a Shift+paste, or for plain prose.
 */
export function markdownClipboardTextParser(text: string, $context: ResolvedPos, plain: boolean): Slice | null {
  if (plain || $context.parent.type.spec.code || !looksLikeMarkdown(text)) return null
  try {
    return markdownPasteSlice(text)
  } catch {
    return null
  }
}
