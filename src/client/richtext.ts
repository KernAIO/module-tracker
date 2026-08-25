import type { RichDoc } from './index.js'

/**
 * Rendering and editing for the ProseMirror documents that descriptions and comments are stored as.
 *
 * The tracker stores rich text as Tiptap JSON so it can round-trip through the API, search and
 * email without becoming HTML soup. Rendering it here rather than trusting a server-side string
 * keeps the rule simple: only the node and mark types below ever reach the DOM, and every piece of
 * text is escaped, so a pasted `<script>` is text and nothing else.
 *
 * The editor is a plain textarea for now; the surrounding format is already the real one, so
 * swapping in a Tiptap surface later changes the input and nothing that reads it.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)

/** Only links that navigate somewhere safe survive. */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  return /^(https?:|mailto:|\/)/i.test(trimmed) ? trimmed : null
}

interface Node {
  type?: string
  text?: string
  content?: Node[]
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
}

function renderMarks(html: string, marks: Node['marks']): string {
  let out = html
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
      case 'strong':
        out = `<strong>${out}</strong>`
        break
      case 'italic':
      case 'em':
        out = `<em>${out}</em>`
        break
      case 'code':
        out = `<code>${out}</code>`
        break
      case 'strike':
        out = `<s>${out}</s>`
        break
      case 'link': {
        const href = safeHref(mark.attrs?.href)
        if (href) out = `<a href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${out}</a>`
        break
      }
      default:
        break
    }
  }
  return out
}

function renderNode(node: Node): string {
  if (node.type === 'text') return renderMarks(escapeHtml(node.text ?? ''), node.marks)
  if (node.type === 'mention') {
    // A mention is an inline leaf: it has no children, so the default branch below would render
    // nothing and the mention would simply disappear from the comment.
    const label = String(node.attrs?.label ?? '')
    const id = String(node.attrs?.id ?? '')
    return `<span class="kern-mention" data-user-id="${escapeHtml(id)}">@${escapeHtml(label)}</span>`
  }
  const children = (node.content ?? []).map(renderNode).join('')
  switch (node.type) {
    case 'paragraph':
      return children ? `<p>${children}</p>` : '<p><br></p>'
    case 'heading': {
      const level = Math.min(4, Math.max(2, Number(node.attrs?.level ?? 2)))
      return `<h${level}>${children}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${children}</ul>`
    case 'orderedList':
      return `<ol>${children}</ol>`
    case 'listItem':
      return `<li>${children}</li>`
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`
    case 'codeBlock':
      return `<pre><code>${children}</code></pre>`
    case 'hardBreak':
      return '<br>'
    case 'horizontalRule':
      return '<hr>'
    default:
      return children
  }
}

/** Sanitised HTML for a stored document. Returns an empty string for an empty or missing document. */
export function renderDoc(doc: RichDoc | null | undefined): string {
  if (!doc) return ''
  return (doc.content ?? []).map((n) => renderNode(n as Node)).join('')
}

/** Plain text, for previews, search and the textarea editor. */
export function textFromDoc(doc: RichDoc | null | undefined): string {
  if (!doc) return ''
  const walk = (node: Node): string => {
    if (typeof node.text === 'string') return node.text
    // A mention becomes the literal that produced it, so editing a comment round-trips instead of
    // quietly deleting whoever was mentioned.
    if (node.type === 'mention') return `@${String(node.attrs?.label ?? '')}`
    return (node.content ?? []).map(walk).join('')
  }
  return (doc.content ?? [])
    .map((n) => walk(n as Node))
    .join('\n\n')
    .trim()
}

/** Wrap typed text back into a document: blank lines separate paragraphs, single ones break. */
export function docFromText(text: string): RichDoc | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const paragraphs = trimmed.split(/\n{2,}/)
  return {
    type: 'doc',
    content: paragraphs.map((para) => ({
      type: 'paragraph',
      content: para
        .split('\n')
        .flatMap((line, i) =>
          i === 0 ? [{ type: 'text', text: line }] : [{ type: 'hardBreak' }, { type: 'text', text: line }],
        )
        .filter((n) => n.type !== 'text' || (n as { text?: string }).text),
    })),
  }
}

/**
 * Whether a document has nothing in it.
 *
 * The editor stores an empty document as `null`, but a document that once had text and was cleared
 * arrives as a doc holding one empty paragraph — perfectly truthy, and the reason a "Send" button
 * that only checked for `null` stayed enabled on an empty comment.
 */
export function isEmptyDoc(doc: RichDoc | null | undefined): boolean {
  return !doc || textFromDoc(doc).trim() === ''
}
