/**
 * Just enough CSV to show somebody what they are about to import.
 *
 * The server parses the file properly; this reads the first few lines so the mapping screen can
 * offer the real column names and a row of real values. Guessing at column names, or asking
 * somebody to map "column 3", turns a five-minute import into a spreadsheet-counting exercise.
 */

/** Split one CSV line, honouring quotes — a title with a comma in it is one field, not two. */
export function splitLine(line: string, delimiter = ','): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quoted) {
      // "" inside a quoted field is one literal quote.
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') quoted = false
      else current += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === delimiter) {
      fields.push(current.trim())
      current = ''
    } else current += char
  }
  fields.push(current.trim())
  return fields
}

export interface CsvPreview {
  columns: string[]
  /** the first rows, for showing what a column actually holds */
  rows: string[][]
}

/**
 * Column names and a few rows from the start of a file.
 *
 * Without a header row the columns are numbered, because that is what the server will index them
 * by — showing "1, 2, 3" where the server counts "0, 1, 2" would map every field one place out.
 */
export function previewCsv(text: string, opts: { delimiter?: string; hasHeader?: boolean } = {}): CsvPreview {
  const delimiter = opts.delimiter || ','
  const hasHeader = opts.hasHeader ?? true
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 6)
  if (!lines.length) return { columns: [], rows: [] }

  const first = splitLine(lines[0]!, delimiter)
  const columns = hasHeader ? first : first.map((_, i) => String(i))
  const rows = (hasHeader ? lines.slice(1) : lines).map((line) => splitLine(line, delimiter))
  return { columns, rows: rows.slice(0, 3) }
}
