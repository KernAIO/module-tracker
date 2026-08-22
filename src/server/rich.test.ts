import { describe, expect, it } from 'vitest'
import type { RichDoc } from '../contract/models.js'
import { docToText, extractMentions, preview, stripQuotedReply, textToDoc } from './rich.js'

const doc = (...content: unknown[]): RichDoc => ({ type: 'doc', content }) as unknown as RichDoc

const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })
const text = (value: string) => ({ type: 'text', text: value })
const mention = (id: string, label: string, kind = 'user') => ({
  type: 'mention',
  attrs: { id, label, kind },
})

describe('docToText', () => {
  it('separates top-level paragraphs with a blank line', () => {
    expect(docToText(doc(paragraph(text('first')), paragraph(text('second'))))).toBe('first\n\nsecond')
  })

  it('renders mentions with an @ so notifications read naturally', () => {
    expect(docToText(doc(paragraph(text('ping '), mention('u1', 'ada'))))).toBe('ping @ada')
  })

  it('turns hard breaks into newlines and collapses runs of blank lines', () => {
    const value = docToText(
      doc(paragraph(text('a'), { type: 'hardBreak' }, text('b')), paragraph(), paragraph(text('c'))),
    )
    expect(value).toBe('a\nb\n\nc')
  })

  it('walks nested lists', () => {
    const list = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(text('one'))] },
        { type: 'listItem', content: [paragraph(text('two'))] },
      ],
    }
    expect(docToText(doc(list))).toBe('one\ntwo')
  })

  it('returns an empty string for null or an empty document', () => {
    expect(docToText(null)).toBe('')
    expect(docToText(doc())).toBe('')
  })
})

describe('extractMentions', () => {
  it('collects user mention ids in document order, deduplicated', () => {
    const value = doc(
      paragraph(mention('u1', 'ada'), text(' and '), mention('u2', 'linus')),
      paragraph(mention('u1', 'ada')),
    )
    expect(extractMentions(value)).toEqual(['u1', 'u2'])
  })

  it('ignores group mentions and mentions without an id', () => {
    const value = doc(paragraph(mention('g1', 'qa', 'group'), { type: 'mention', attrs: { label: 'x' } }))
    expect(extractMentions(value)).toEqual([])
  })

  it('ignores mentions inside code blocks and inline code', () => {
    const inCodeBlock = doc({ type: 'codeBlock', content: [mention('u1', 'ada')] })
    expect(extractMentions(inCodeBlock)).toEqual([])
    const inlineCode = doc(paragraph({ ...mention('u2', 'linus'), marks: [{ type: 'code' }] }))
    expect(extractMentions(inlineCode)).toEqual([])
  })

  it('returns nothing for an empty document', () => {
    expect(extractMentions(null)).toEqual([])
    expect(extractMentions(doc())).toEqual([])
  })
})

describe('textToDoc', () => {
  it('round-trips through docToText', () => {
    const source = 'first line\nsecond line\n\nnew paragraph'
    expect(docToText(textToDoc(source))).toBe(source)
  })

  it('produces a valid ProseMirror document', () => {
    const value = textToDoc('hello')
    expect(value.type).toBe('doc')
    expect(value.content?.[0]).toMatchObject({ type: 'paragraph' })
  })
})

describe('preview', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(preview('a   b\n\nc')).toBe('a b c')
    expect(preview('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('stripQuotedReply', () => {
  it('drops the quoted history from an email reply', () => {
    const body = ['Thanks, that fixed it.', '', 'On Tue, Ada wrote:', '> did you try turning it off'].join(
      '\n',
    )
    expect(stripQuotedReply(body)).toBe('Thanks, that fixed it.')
  })

  it('keeps a message that quotes nothing', () => {
    expect(stripQuotedReply('just a plain reply')).toBe('just a plain reply')
  })

  it('keeps a message that is only a quote', () => {
    expect(stripQuotedReply('> everything is quoted')).toBe('> everything is quoted')
  })
})
