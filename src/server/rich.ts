import type { RichDoc } from '../contract/models.js'

/**
 * Helpers for the Tiptap/ProseMirror JSON stored in issue descriptions and comments.
 * Mention nodes are `{ type: 'mention', attrs: { id, label, kind: 'user' | 'group' } }`.
 */
export type PmNode = {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'listItem',
  'bulletList',
  'orderedList',
  'taskItem',
  'taskList',
  'horizontalRule',
  'table',
  'tableRow',
])

const isBlock = (node: PmNode) => !!node.type && BLOCK_TYPES.has(node.type)
/** A block with no block children — the thing that actually holds a line of text. */
const isLeafBlock = (node: PmNode) => isBlock(node) && !(node.content ?? []).some(isBlock)

/**
 * Plain-text rendering used for search, notifications and previews.
 * Top-level blocks are separated by a blank line and nested ones (list items, table cells) by a
 * single newline, so `textToDoc(x)` round-trips back to `x`.
 */
export function docToText(doc: RichDoc | PmNode | null | undefined): string {
  if (!doc) return ''
  const out: string[] = []
  const walk = (node: PmNode, depth: number) => {
    if (node.type === 'text') {
      out.push(node.text ?? '')
      return
    }
    if (node.type === 'hardBreak') {
      out.push('\n')
      return
    }
    if (node.type === 'mention') {
      const attrs = node.attrs ?? {}
      out.push(`@${(attrs.label as string) ?? (attrs.id as string) ?? ''}`)
      return
    }
    for (const child of node.content ?? []) walk(child, depth + 1)
    if (isLeafBlock(node) && depth > 0) out.push(depth === 1 ? '\n\n' : '\n')
  }
  walk(doc as PmNode, 0)
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** User ids mentioned in a document. Mentions inside code are ignored. */
export function extractMentions(doc: RichDoc | PmNode | null | undefined): string[] {
  const users = new Set<string>()
  const walk = (node: PmNode, inCode: boolean) => {
    const code = inCode || node.type === 'codeBlock' || (node.marks ?? []).some((m) => m.type === 'code')
    if (node.type === 'mention' && !code) {
      const attrs = node.attrs ?? {}
      const kind = (attrs.kind as string) ?? 'user'
      const id = typeof attrs.id === 'string' ? attrs.id : null
      if (kind === 'user' && id) users.add(id)
      return
    }
    for (const child of node.content ?? []) walk(child, code)
  }
  if (doc) walk(doc as PmNode, false)
  return [...users]
}

/** Build a minimal document from plain text (email ingest, intake forms, automations). */
export function textToDoc(text: string): RichDoc {
  const paragraphs = text.split(/\n{2,}/).map((block) => {
    const content: PmNode[] = []
    block.split('\n').forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' })
      if (line.length) content.push({ type: 'text', text: line })
    })
    return { type: 'paragraph', content: content.length ? content : undefined }
  })
  return { type: 'doc', content: paragraphs as Array<Record<string, unknown>> }
}

/** Short single-line preview (notifications, search snippets). */
export function preview(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Strip an email reply quote so a threaded reply does not repeat the whole conversation. */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n')
  const cut = lines.findIndex((l) =>
    /^(>|On .+ wrote:|-----Original Message-----|_{10,}|From: )/.test(l.trim()),
  )
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim()
}
