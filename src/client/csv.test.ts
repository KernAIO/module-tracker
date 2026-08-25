import { describe, expect, it } from 'vitest'
import { previewCsv, splitLine } from './csv.js'

describe('splitLine', () => {
  it('splits on the delimiter', () => {
    expect(splitLine('a,b,c')).toEqual(['a', 'b', 'c'])
    expect(splitLine('a;b', ';')).toEqual(['a', 'b'])
  })

  it('keeps a quoted field whole, delimiter and all', () => {
    // The single most common way a naive import mangles every row after the first title.
    expect(splitLine('1,"Crash, then burn",high')).toEqual(['1', 'Crash, then burn', 'high'])
  })

  it('reads a doubled quote as one quote', () => {
    expect(splitLine('"He said ""no""",x')).toEqual(['He said "no"', 'x'])
  })

  it('keeps empty fields, so the columns still line up', () => {
    expect(splitLine('a,,c')).toEqual(['a', '', 'c'])
    expect(splitLine(',')).toEqual(['', ''])
  })
})

describe('previewCsv', () => {
  const file = 'Title,Priority\nFix the thing,high\nAnother,low\n'

  it('takes the column names from the header', () => {
    expect(previewCsv(file).columns).toEqual(['Title', 'Priority'])
    expect(previewCsv(file).rows[0]).toEqual(['Fix the thing', 'high'])
  })

  it('numbers the columns from zero without a header, matching what the server indexes by', () => {
    // Showing 1,2,3 where the server counts 0,1,2 maps every field one place out.
    const preview = previewCsv(file, { hasHeader: false })
    expect(preview.columns).toEqual(['0', '1'])
    expect(preview.rows[0]).toEqual(['Title', 'Priority'])
  })

  it('ignores blank lines and stops after a few rows', () => {
    const many = ['H', ...Array.from({ length: 20 }, (_, i) => `row ${i}`), '', ''].join('\n')
    const preview = previewCsv(many)
    expect(preview.rows).toHaveLength(3)
  })

  it('has nothing to show for an empty file', () => {
    expect(previewCsv('')).toEqual({ columns: [], rows: [] })
    expect(previewCsv('\n\n')).toEqual({ columns: [], rows: [] })
  })
})
