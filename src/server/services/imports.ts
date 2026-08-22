import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq } from 'drizzle-orm'
import {
  type CreateIssue,
  type CsvMapping,
  CsvMapping as CsvMappingSchema,
  type FieldType,
  type ImportJob,
  type ImportSource,
  type Priority,
} from '../../contract/models.js'
import { textToDoc } from '../rich.js'
import { importJobs } from '../schema.js'
import type { AccessService } from './access.js'
import type { ConfigService } from './config.js'
import { toImportJob } from './db.js'
import type { IssueService } from './issues.js'
import type { PlanningService } from './planning.js'

const MODULE_JOB = 'tracker.import'
const MAX_ROWS = 20_000

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CR/LF inside quotes. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\r') continue
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length))
}

/** CSV, Jira and Linear imports. The work happens in a background job so the request returns at once. */
export class ImportService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly issuesService: IssueService,
    private readonly planning: PlanningService,
  ) {}

  async list(tx: Tx, principal: Principal, workspaceId: string, projectId: string): Promise<ImportJob[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.import.run')
    const rows = await tx
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.projectId, projectId)))
      .orderBy(desc(importJobs.createdAt))
      .limit(100)
    return rows.map(toImportJob)
  }

  async get(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<ImportJob> {
    const row = await this.row(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, row.projectId, 'tracker.import.run')
    return toImportJob(row)
  }

  private async row(tx: Tx, workspaceId: string, id: string) {
    const [row] = await tx
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Import job')
    return row
  }

  async start(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    input: { source: ImportSource; fileId: string; mapping: Record<string, unknown> },
  ): Promise<ImportJob> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.import.run')
    const id = uuidv7()
    const [row] = await tx
      .insert(importJobs)
      .values({
        id,
        workspaceId,
        projectId,
        source: input.source,
        fileId: input.fileId,
        mapping: input.mapping,
        status: 'pending',
        progress: { total: 0, processed: 0, created: 0, skipped: 0, failed: 0 },
        createdBy: principal.userId ?? null,
      })
      .returning()
    await this.kernel.jobs.send(MODULE_JOB, { workspaceId, importJobId: id }).catch((err) => {
      this.kernel.log.warn({ err: String(err) }, 'tracker: could not queue import')
    })
    return toImportJob(row!)
  }

  async cancel(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<ImportJob> {
    const current = await this.row(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.import.run')
    if (current.status === 'completed') return toImportJob(current)
    const [row] = await tx
      .update(importJobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, id)))
      .returning()
    return toImportJob(row!)
  }

  // ------------------------------------------------------------------ runner

  private async fileText(workspaceId: string, fileId: string): Promise<string> {
    const file = await this.kernel.call<{ key: string; workspaceId: string } | null>('core.files.get', {
      id: fileId,
    })
    if (!file) throw KernError.notFound('File')
    if (file.workspaceId !== workspaceId) throw KernError.forbidden()
    const object = await this.kernel.storage.get(file.key)
    const chunks: Buffer[] = []
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Buffer))
    return Buffer.concat(chunks).toString('utf8')
  }

  /** Executed by the `tracker.import` job. */
  async run(workspaceId: string, importJobId: string): Promise<void> {
    const job = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
      this.row(tx, workspaceId, importJobId),
    )
    if (job.status !== 'pending') return
    await this.patch(workspaceId, importJobId, { status: 'running', startedAt: new Date() })

    const errors: Array<{ row: number | null; message: string }> = []
    const progress = { total: 0, processed: 0, created: 0, skipped: 0, failed: 0 }
    try {
      const text = await this.fileText(workspaceId, job.fileId)
      // Every CSV cell is a string, so a custom column needs its field's type to become the value
      // the field actually holds. Without this a `number` column imports as text: it validates
      // nowhere, sorts alphabetically, and never matches a numeric KQL comparison.
      const fieldTypes = new Map(
        (
          await this.kernel.database.withWorkspace(workspaceId, (tx) =>
            this.config.listFields(tx, workspaceId, { projectId: job.projectId }),
          )
        ).map((f) => [f.key, f.type] as const),
      )
      const records =
        job.source === 'csv'
          ? this.csvRecords(text, CsvMappingSchema.parse(job.mapping ?? {}), fieldTypes)
          : this.jsonRecords(text, job.source as ImportSource)
      progress.total = records.length
      await this.patch(workspaceId, importJobId, { progress })

      for (const [index, record] of records.entries()) {
        const current = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
          this.row(tx, workspaceId, importJobId),
        )
        if (current.status === 'cancelled') return
        progress.processed = index + 1
        try {
          if (!record.title?.trim()) {
            progress.skipped++
            continue
          }
          await this.kernel.database.withWorkspace(workspaceId, async (tx) => {
            const labelIds: string[] = []
            for (const name of record.labels ?? [])
              labelIds.push(await this.planning.ensureLabel(tx, workspaceId, job.projectId, name))
            await this.issuesService.create(
              tx,
              this.kernel.system,
              workspaceId,
              {
                projectId: job.projectId,
                title: record.title.slice(0, 500),
                ...(record.description ? { description: textToDoc(record.description) } : {}),
                ...(record.priority ? { priority: record.priority } : {}),
                ...(record.typeId ? { typeId: record.typeId } : {}),
                ...(record.statusId ? { statusId: record.statusId } : {}),
                ...(record.assigneeId ? { assigneeIds: [record.assigneeId as never] } : {}),
                ...(record.dueDate ? { dueDate: record.dueDate } : {}),
                ...(record.estimate === undefined ? {} : { estimate: record.estimate }),
                ...(labelIds.length ? { labelIds } : {}),
                ...(Object.keys(record.custom ?? {}).length ? { custom: record.custom } : {}),
              } as CreateIssue,
              { source: 'import', system: true, externalRef: record.externalRef ?? null },
            )
          })
          progress.created++
        } catch (err) {
          progress.failed++
          errors.push({ row: index + 1, message: err instanceof Error ? err.message : String(err) })
        }
        if (progress.processed % 25 === 0) await this.patch(workspaceId, importJobId, { progress, errors })
      }
      await this.patch(workspaceId, importJobId, {
        status: 'completed',
        progress,
        errors,
        finishedAt: new Date(),
      })
    } catch (err) {
      errors.push({ row: null, message: err instanceof Error ? err.message : String(err) })
      await this.patch(workspaceId, importJobId, {
        status: 'failed',
        progress,
        errors,
        finishedAt: new Date(),
      })
    }
  }

  private async patch(
    workspaceId: string,
    id: string,
    values: Partial<typeof importJobs.$inferInsert>,
  ): Promise<void> {
    await this.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .update(importJobs)
        .set(values)
        .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, id))),
    )
  }

  // ------------------------------------------------------------------ record extraction

  private csvRecords(text: string, mapping: CsvMapping, fieldTypes: Map<string, FieldType>): ImportRecord[] {
    const rows = parseCsv(text, mapping.delimiter || ',')
    if (!rows.length) return []
    const header = mapping.hasHeader ? rows[0]!.map((h) => h.trim()) : []
    const body = mapping.hasHeader ? rows.slice(1) : rows
    const columnFor = (field: string): number => {
      const source = Object.entries(mapping.columns).find(([, target]) => target === field)?.[0]
      if (source === undefined) return -1
      const asIndex = Number(source)
      if (!Number.isNaN(asIndex) && !mapping.hasHeader) return asIndex
      return header.indexOf(source)
    }
    const indices = {
      title: columnFor('title'),
      description: columnFor('description'),
      status: columnFor('status'),
      type: columnFor('type'),
      priority: columnFor('priority'),
      assignee: columnFor('assignee'),
      labels: columnFor('labels'),
      dueDate: columnFor('due'),
      estimate: columnFor('estimate'),
      externalRef: columnFor('key'),
    }
    const customColumns = Object.entries(mapping.columns).filter(([, target]) => target.startsWith('cf.'))

    return body.slice(0, MAX_ROWS).map((row) => {
      const cell = (index: number) => (index >= 0 ? (row[index]?.trim() ?? '') : '')
      const custom: Record<string, unknown> = {}
      for (const [source, target] of customColumns) {
        const index = mapping.hasHeader ? header.indexOf(source) : Number(source)
        const value = cell(index)
        if (!value) continue
        const key = target.slice(3)
        const coerced = coerceCell(value, fieldTypes.get(key))
        if (coerced !== undefined) custom[key] = coerced
      }
      const labelsCell = cell(indices.labels)
      const estimate = Number(cell(indices.estimate))
      return {
        title: cell(indices.title),
        description: cell(indices.description) || null,
        statusId: mapping.statusMap[cell(indices.status)] ?? null,
        typeId: mapping.typeMap[cell(indices.type)] ?? null,
        priority: (mapping.priorityMap[cell(indices.priority)] ?? null) as Priority | null,
        assigneeId: mapping.userMap[cell(indices.assignee)] ?? null,
        labels:
          mapping.createMissingLabels && labelsCell
            ? labelsCell
                .split(/[,;]/)
                .map((l) => l.trim())
                .filter(Boolean)
            : [],
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(cell(indices.dueDate)) ? cell(indices.dueDate) : null,
        estimate: Number.isFinite(estimate) && cell(indices.estimate) ? estimate : undefined,
        externalRef: cell(indices.externalRef) || null,
        custom,
      }
    })
  }

  /** Jira and Linear exports are both JSON arrays (or `{issues: [...]}`) of loosely-shaped objects. */
  private jsonRecords(text: string, source: ImportSource): ImportRecord[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw KernError.badRequest('The import file is not valid JSON')
    }
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { issues?: unknown[] })?.issues ?? (parsed as { data?: unknown[] })?.data ?? [])
    return (list as Array<Record<string, unknown>>).slice(0, MAX_ROWS).map((raw) => {
      const fields = (raw.fields as Record<string, unknown>) ?? raw
      const title = String(fields.summary ?? fields.title ?? raw.title ?? '')
      const description = fields.description ?? raw.description
      const priorityName = String(
        (fields.priority as { name?: string })?.name ?? raw.priority ?? '',
      ).toLowerCase()
      const labels = Array.isArray(fields.labels)
        ? (fields.labels as unknown[]).map(String)
        : Array.isArray(raw.labels)
          ? (raw.labels as Array<{ name?: string } | string>).map((l) =>
              typeof l === 'string' ? l : (l.name ?? ''),
            )
          : []
      return {
        title,
        description: typeof description === 'string' ? description : null,
        statusId: null,
        typeId: null,
        priority: (['none', 'low', 'medium', 'high', 'urgent'] as const).includes(priorityName as Priority)
          ? (priorityName as Priority)
          : null,
        assigneeId: null,
        labels: labels.filter(Boolean),
        dueDate: typeof fields.duedate === 'string' ? fields.duedate : null,
        estimate: typeof raw.estimate === 'number' ? raw.estimate : undefined,
        externalRef: String(raw.key ?? raw.id ?? '') || null,
        custom: {},
        sourceKind: source,
      }
    })
  }

  /** Available so the router can validate a type id before enqueuing. */
  configRef(): ConfigService {
    return this.config
  }
}

interface ImportRecord {
  title: string
  description: string | null
  statusId: string | null
  typeId: string | null
  priority: Priority | null
  assigneeId: string | null
  labels: string[]
  dueDate: string | null
  estimate?: number | undefined
  externalRef: string | null
  custom: Record<string, unknown>
  sourceKind?: ImportSource
}

/**
 * A CSV cell as the field's type. Returns `undefined` when the text cannot be that type, so the
 * column is left unset rather than imported as something the field can never hold — the row still
 * imports, and the gap is visible instead of being a wrong value.
 */
function coerceCell(text: string, type: FieldType | undefined): unknown {
  switch (type) {
    case undefined:
      // an unmapped key; `issues.create` reports it per row
      return text
    case 'number':
    case 'formula': {
      const n = Number(text)
      return Number.isFinite(n) ? n : undefined
    }
    case 'checkbox': {
      const v = text.toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(v)) return true
      if (['false', 'no', 'n', '0'].includes(v)) return false
      return undefined
    }
    case 'date':
    case 'datetime':
      return Number.isNaN(Date.parse(text)) ? undefined : new Date(text).toISOString()
    case 'multiselect':
    case 'multiuser':
    case 'label':
    case 'relation':
      return text
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    default:
      return text
  }
}
