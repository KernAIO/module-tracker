import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import {
  builtinRegistry,
  createWorkflowFromTemplate,
  type RuleRegistry,
  sortedStatuses,
  validateDefinition,
  type WorkflowDefinition,
  type WorkflowTemplateId,
  workflowTemplates,
} from '@kernhq/workflow'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  type FieldDef,
  HierarchyRules,
  type StatusInfo,
  type TypeScheme,
  type UpsertFieldDef,
  type UpsertWorkflow,
  type UpsertWorkflowScheme as UpsertWorkflowSchemeSchema,
  type UpsertWorkItemType,
  type Workflow,
  type WorkflowScheme,
  type WorkItemType,
} from '../../contract/models.js'
import {
  fieldDefs,
  hierarchyRules,
  issues,
  projects,
  typeSchemes,
  workflowSchemes,
  workflows,
  workItemTypes,
} from '../schema.js'
import type { AccessService } from './access.js'
import {
  type FieldDefRow,
  type ProjectRow,
  toFieldDef,
  toTypeScheme,
  toWorkflow,
  toWorkflowScheme,
  toWorkItemType,
  type WorkflowRow,
  type WorkItemTypeRow,
} from './db.js'
import type { NotifyService } from './notify.js'

type UpsertWorkflowScheme = z.infer<typeof UpsertWorkflowSchemeSchema>

const DEFAULT_HIERARCHY: HierarchyRules = HierarchyRules.parse({})

let validationRegistry: RuleRegistry | null = null
/** Rule registry used to check that a definition only references rules the tracker can execute. */
const registryForValidation = (): RuleRegistry => {
  validationRegistry ??= builtinRegistry()
  return validationRegistry
}

/** Types seeded into a fresh project, per project template. */
const TYPE_SEEDS: Record<string, Array<{ key: string; name: string; level: number; icon: string }>> = {
  software: [
    { key: 'epic', name: 'Epic', level: 1, icon: 'zap' },
    { key: 'story', name: 'Story', level: 0, icon: 'bookmark' },
    { key: 'task', name: 'Task', level: 0, icon: 'square-check-big' },
    { key: 'bug', name: 'Bug', level: 0, icon: 'bug' },
    { key: 'sub_task', name: 'Sub-task', level: -1, icon: 'git-branch' },
  ],
  kanban: [
    { key: 'task', name: 'Task', level: 0, icon: 'square-check-big' },
    { key: 'bug', name: 'Bug', level: 0, icon: 'bug' },
  ],
  simple: [{ key: 'task', name: 'Task', level: 0, icon: 'square-check-big' }],
  blank: [{ key: 'task', name: 'Task', level: 0, icon: 'square-check-big' }],
}

const DEFAULT_TYPE_KEY: Record<string, string> = {
  software: 'story',
  kanban: 'task',
  simple: 'task',
  blank: 'task',
}

const WORKFLOW_FOR_TEMPLATE: Record<string, WorkflowTemplateId> = {
  software: 'software',
  kanban: 'kanban',
  simple: 'simple',
  blank: 'simple',
}

/** Work item types, custom fields, workflows and the schemes that bind them to projects. */
export class ConfigService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly notify: NotifyService,
  ) {}

  /** Configuration is cached hard in the client, so every change has to be announced. */
  private announce(workspaceId: string, entity: string, id: string, op: 'created' | 'updated' | 'deleted') {
    return this.notify.change(workspaceId, entity, id, op)
  }

  // ------------------------------------------------------------------ work item types

  async listTypes(
    tx: Tx,
    workspaceId: string,
    opts: { projectId?: string; includeArchived?: boolean } = {},
  ): Promise<WorkItemTypeRow[]> {
    const filters = [eq(workItemTypes.workspaceId, workspaceId)]
    if (!opts.includeArchived) filters.push(isNull(workItemTypes.archivedAt))
    if (opts.projectId)
      filters.push(or(isNull(workItemTypes.projectId), eq(workItemTypes.projectId, opts.projectId))!)
    const rows = await tx
      .select()
      .from(workItemTypes)
      .where(and(...filters))
      .orderBy(asc(workItemTypes.order), asc(workItemTypes.name))
    if (!opts.projectId) return rows
    const scheme = await this.typeSchemeFor(tx, workspaceId, opts.projectId)
    if (!scheme?.typeIds.length) return rows
    const allowed = new Set(scheme.typeIds)
    return rows.filter((r) => allowed.has(r.id) || r.projectId === opts.projectId)
  }

  private async typeSchemeFor(tx: Tx, workspaceId: string, projectId: string): Promise<TypeScheme | null> {
    const [project] = await tx
      .select({ typeSchemeId: projects.typeSchemeId })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .limit(1)
    if (!project?.typeSchemeId) return null
    const [row] = await tx.select().from(typeSchemes).where(eq(typeSchemes.id, project.typeSchemeId)).limit(1)
    return row ? toTypeScheme(row) : null
  }

  async getType(tx: Tx, workspaceId: string, id: string): Promise<WorkItemTypeRow> {
    const [row] = await tx
      .select()
      .from(workItemTypes)
      .where(and(eq(workItemTypes.workspaceId, workspaceId), eq(workItemTypes.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Work item type')
    return row
  }

  /** The type new issues get when the caller does not name one. */
  async defaultType(tx: Tx, workspaceId: string, projectId: string): Promise<WorkItemTypeRow> {
    const scheme = await this.typeSchemeFor(tx, workspaceId, projectId)
    const rows = await this.listTypes(tx, workspaceId, { projectId })
    const usable = rows.filter((r) => r.level >= 0)
    const preferred =
      (scheme?.defaultTypeId ? usable.find((r) => r.id === scheme.defaultTypeId) : undefined) ??
      usable.find((r) => r.isDefault && r.projectId === projectId) ??
      usable.find((r) => r.isDefault) ??
      usable.find((r) => r.projectId === projectId) ??
      usable[0]
    if (!preferred) throw KernError.badRequest('This project has no work item types')
    return preferred
  }

  async createType(
    tx: Tx,
    workspaceId: string,
    input: UpsertWorkItemType,
    actorId: string | null,
  ): Promise<WorkItemType> {
    const id = uuidv7()
    await this.assertTypeKeyFree(tx, workspaceId, input.projectId ?? null, input.key)
    if (input.isDefault) await this.clearDefaultType(tx, workspaceId, input.projectId ?? null)
    const [row] = await tx
      .insert(workItemTypes)
      .values({
        id,
        workspaceId,
        projectId: input.projectId ?? null,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        level: input.level,
        isDefault: input.isDefault ?? false,
        workflowId: input.workflowId ?? null,
        fieldLayout: input.fieldLayout ?? [],
        templateBody: input.templateBody ?? null,
        order: input.order ?? 0,
      })
      .returning()
    void actorId
    await this.announce(workspaceId, 'type', row!.id, 'created')
    return toWorkItemType(row!)
  }

  async updateType(
    tx: Tx,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertWorkItemType>,
  ): Promise<WorkItemType> {
    const current = await this.getType(tx, workspaceId, id)
    if (patch.key && patch.key !== current.key)
      await this.assertTypeKeyFree(tx, workspaceId, patch.projectId ?? current.projectId, patch.key)
    if (patch.isDefault) await this.clearDefaultType(tx, workspaceId, current.projectId)
    const [row] = await tx
      .update(workItemTypes)
      .set({
        ...(patch.key === undefined ? {} : { key: patch.key }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(patch.level === undefined ? {} : { level: patch.level }),
        ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
        ...(patch.workflowId === undefined ? {} : { workflowId: patch.workflowId }),
        ...(patch.fieldLayout === undefined ? {} : { fieldLayout: patch.fieldLayout }),
        ...(patch.templateBody === undefined ? {} : { templateBody: patch.templateBody }),
        ...(patch.order === undefined ? {} : { order: patch.order }),
        updatedAt: new Date(),
      })
      .where(and(eq(workItemTypes.workspaceId, workspaceId), eq(workItemTypes.id, id)))
      .returning()
    await this.announce(workspaceId, 'type', id, 'updated')
    return toWorkItemType(row!)
  }

  async archiveType(tx: Tx, workspaceId: string, id: string, archived: boolean): Promise<WorkItemType> {
    if (archived) {
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), eq(issues.typeId, id), isNull(issues.archivedAt)))
      if ((used?.n ?? 0) > 0)
        throw KernError.conflict(`${used!.n} open issues still use this type`, 'tracker.type.in_use')
    }
    const [row] = await tx
      .update(workItemTypes)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(workItemTypes.workspaceId, workspaceId), eq(workItemTypes.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Work item type')
    await this.announce(workspaceId, 'type', id, 'updated')
    return toWorkItemType(row)
  }

  private async assertTypeKeyFree(tx: Tx, workspaceId: string, projectId: string | null, key: string) {
    const [clash] = await tx
      .select({ id: workItemTypes.id })
      .from(workItemTypes)
      .where(
        and(
          eq(workItemTypes.workspaceId, workspaceId),
          eq(workItemTypes.key, key),
          projectId ? eq(workItemTypes.projectId, projectId) : isNull(workItemTypes.projectId),
        ),
      )
      .limit(1)
    if (clash) throw KernError.conflict(`Type key "${key}" is already used`, 'tracker.type.key_taken')
  }

  private async clearDefaultType(tx: Tx, workspaceId: string, projectId: string | null) {
    await tx
      .update(workItemTypes)
      .set({ isDefault: false })
      .where(
        and(
          eq(workItemTypes.workspaceId, workspaceId),
          projectId ? eq(workItemTypes.projectId, projectId) : isNull(workItemTypes.projectId),
        ),
      )
  }

  async hierarchyRules(tx: Tx, workspaceId: string): Promise<HierarchyRules> {
    const [row] = await tx.select().from(hierarchyRules).where(eq(hierarchyRules.workspaceId, workspaceId))
    return row ? HierarchyRules.parse(row.rules ?? {}) : DEFAULT_HIERARCHY
  }

  async setHierarchyRules(tx: Tx, workspaceId: string, rules: HierarchyRules): Promise<HierarchyRules> {
    await tx
      .insert(hierarchyRules)
      .values({ workspaceId, rules })
      .onConflictDoUpdate({ target: hierarchyRules.workspaceId, set: { rules, updatedAt: new Date() } })
    await this.announce(workspaceId, 'hierarchy_rules', workspaceId, 'updated')
    return rules
  }

  // ------------------------------------------------------------------ type schemes

  async listTypeSchemes(tx: Tx, workspaceId: string): Promise<TypeScheme[]> {
    const rows = await tx
      .select()
      .from(typeSchemes)
      .where(eq(typeSchemes.workspaceId, workspaceId))
      .orderBy(asc(typeSchemes.createdAt))
    return rows.map(toTypeScheme)
  }

  async createTypeScheme(
    tx: Tx,
    workspaceId: string,
    input: { name: string; typeIds: string[]; defaultTypeId?: string | null },
  ): Promise<TypeScheme> {
    const [row] = await tx
      .insert(typeSchemes)
      .values({
        id: uuidv7(),
        workspaceId,
        name: input.name,
        typeIds: input.typeIds,
        defaultTypeId: input.defaultTypeId ?? null,
      })
      .returning()
    await this.announce(workspaceId, 'type_scheme', row!.id, 'created')
    return toTypeScheme(row!)
  }

  async updateTypeScheme(
    tx: Tx,
    workspaceId: string,
    id: string,
    patch: { name?: string; typeIds?: string[]; defaultTypeId?: string | null },
  ): Promise<TypeScheme> {
    const [row] = await tx
      .update(typeSchemes)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.typeIds === undefined ? {} : { typeIds: patch.typeIds }),
        ...(patch.defaultTypeId === undefined ? {} : { defaultTypeId: patch.defaultTypeId }),
      })
      .where(and(eq(typeSchemes.workspaceId, workspaceId), eq(typeSchemes.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Type scheme')
    await this.announce(workspaceId, 'type_scheme', id, 'updated')
    return toTypeScheme(row)
  }

  async deleteTypeScheme(tx: Tx, workspaceId: string, id: string): Promise<void> {
    await tx.update(projects).set({ typeSchemeId: null }).where(eq(projects.typeSchemeId, id))
    await tx.delete(typeSchemes).where(and(eq(typeSchemes.workspaceId, workspaceId), eq(typeSchemes.id, id)))
    await this.announce(workspaceId, 'type_scheme', id, 'deleted')
  }

  // ------------------------------------------------------------------ custom fields

  async listFieldRows(
    tx: Tx,
    workspaceId: string,
    opts: { projectId?: string; includeArchived?: boolean } = {},
  ): Promise<FieldDefRow[]> {
    const filters = [eq(fieldDefs.workspaceId, workspaceId)]
    if (!opts.includeArchived) filters.push(isNull(fieldDefs.archivedAt))
    if (opts.projectId)
      filters.push(or(isNull(fieldDefs.projectId), eq(fieldDefs.projectId, opts.projectId))!)
    const rows = await tx
      .select()
      .from(fieldDefs)
      .where(and(...filters))
      .orderBy(asc(fieldDefs.order), asc(fieldDefs.name))
    return rows
  }

  async listFields(
    tx: Tx,
    workspaceId: string,
    opts: { projectId?: string; includeArchived?: boolean } = {},
  ): Promise<FieldDef[]> {
    return (await this.listFieldRows(tx, workspaceId, opts)).map(toFieldDef)
  }

  /** Fields visible across a set of projects (KQL autocomplete over a multi-project view). */
  async fieldsForProjects(tx: Tx, workspaceId: string, projectIds: string[]): Promise<FieldDef[]> {
    if (!projectIds.length) return this.listFields(tx, workspaceId)
    const seen = new Map<string, FieldDef>()
    for (const projectId of projectIds)
      for (const f of await this.listFields(tx, workspaceId, { projectId })) seen.set(f.id, f)
    return [...seen.values()]
  }

  async createField(tx: Tx, workspaceId: string, input: UpsertFieldDef): Promise<FieldDef> {
    const [clash] = await tx
      .select({ id: fieldDefs.id })
      .from(fieldDefs)
      .where(
        and(
          eq(fieldDefs.workspaceId, workspaceId),
          // Deliberately not scoped by project: the key is the `issues.custom` key, so it must be
          // unique across the workspace. This mirrors the unique index — checking a narrower scope
          // here would let a collision through to a raw constraint violation.
          eq(fieldDefs.key, input.key),
        ),
      )
      .limit(1)
    if (clash) throw KernError.conflict(`Field key "${input.key}" is already used`, 'tracker.field.key_taken')
    const [row] = await tx
      .insert(fieldDefs)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId: input.projectId ?? null,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        options: input.options ?? [],
        defaultValue: input.defaultValue ?? null,
        config: input.config ?? {},
        searchable: input.searchable ?? false,
        required: input.required ?? false,
        showInCards: input.showInCards ?? false,
        order: input.order ?? 0,
      })
      .returning()
    await this.announce(workspaceId, 'field', row!.id, 'created')
    return toFieldDef(row!)
  }

  async updateField(
    tx: Tx,
    workspaceId: string,
    id: string,
    patch: Partial<Omit<UpsertFieldDef, 'key' | 'type'>>,
  ): Promise<FieldDef> {
    const [row] = await tx
      .update(fieldDefs)
      .set({
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.options === undefined ? {} : { options: patch.options }),
        ...(patch.defaultValue === undefined ? {} : { defaultValue: patch.defaultValue }),
        ...(patch.config === undefined ? {} : { config: patch.config }),
        ...(patch.searchable === undefined ? {} : { searchable: patch.searchable }),
        ...(patch.required === undefined ? {} : { required: patch.required }),
        ...(patch.showInCards === undefined ? {} : { showInCards: patch.showInCards }),
        ...(patch.order === undefined ? {} : { order: patch.order }),
        updatedAt: new Date(),
      })
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Field')
    await this.announce(workspaceId, 'field', id, 'updated')
    return toFieldDef(row)
  }

  async archiveField(tx: Tx, workspaceId: string, id: string, archived: boolean): Promise<FieldDef> {
    const [row] = await tx
      .update(fieldDefs)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Field')
    await this.announce(workspaceId, 'field', id, 'updated')
    return toFieldDef(row)
  }

  /** Deleting a field also strips its values from every issue: the key would otherwise be unreachable. */
  async deleteField(tx: Tx, workspaceId: string, id: string): Promise<void> {
    const [row] = await tx
      .select()
      .from(fieldDefs)
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Field')
    await tx
      .update(issues)
      .set({ custom: sql`${issues.custom} - ${row.key}` })
      .where(and(eq(issues.workspaceId, workspaceId), sql`${issues.custom} ? ${row.key}`))
    await tx.delete(fieldDefs).where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, id)))
    await this.announce(workspaceId, 'field', id, 'deleted')
  }

  // ------------------------------------------------------------------ workflows

  async listWorkflows(
    tx: Tx,
    workspaceId: string,
    opts: { projectId?: string; includeArchived?: boolean } = {},
  ): Promise<Workflow[]> {
    const filters = [eq(workflows.workspaceId, workspaceId)]
    if (!opts.includeArchived) filters.push(isNull(workflows.archivedAt))
    if (opts.projectId)
      filters.push(or(isNull(workflows.projectId), eq(workflows.projectId, opts.projectId))!)
    const rows = await tx
      .select()
      .from(workflows)
      .where(and(...filters))
      .orderBy(asc(workflows.name))
    const usage = new Map<string, number>()
    for (const row of rows) {
      const [n] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(workItemTypes)
        .where(and(eq(workItemTypes.workspaceId, workspaceId), eq(workItemTypes.workflowId, row.id)))
      usage.set(row.id, n?.n ?? 0)
    }
    return rows.map((r) => toWorkflow(r, usage.get(r.id) ?? 0))
  }

  async getWorkflowRow(tx: Tx, workspaceId: string, id: string): Promise<WorkflowRow> {
    const [row] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Workflow')
    return row
  }

  async createWorkflow(tx: Tx, workspaceId: string, input: UpsertWorkflow): Promise<Workflow> {
    // The registry has to be passed here, not only in `validate()`. Without it an unknown rule type
    // saves happily and only surfaces later as a blocked transition or a dropped intent — which
    // meant `workflows.validate` rejected definitions that `workflows.create` accepted.
    const validated = validateDefinition(input.definition, registryForValidation())
    if (!validated.ok)
      throw KernError.badRequest('Invalid workflow definition', { problems: validated.problems })
    if (input.isDefault) await this.clearDefaultWorkflow(tx, workspaceId, input.projectId ?? null)
    const [row] = await tx
      .insert(workflows)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId: input.projectId ?? null,
        name: input.name,
        description: input.description ?? null,
        definition: validated.definition,
        isDefault: input.isDefault ?? false,
      })
      .returning()
    await this.announce(workspaceId, 'workflow', row!.id, 'created')
    return toWorkflow(row!, 0)
  }

  async updateWorkflow(
    tx: Tx,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertWorkflow>,
  ): Promise<Workflow> {
    const current = await this.getWorkflowRow(tx, workspaceId, id)
    let definition = current.definition as WorkflowDefinition
    if (patch.definition) {
      const validated = validateDefinition(patch.definition, registryForValidation())
      if (!validated.ok)
        throw KernError.badRequest('Invalid workflow definition', { problems: validated.problems })
      definition = validated.definition
      await this.assertStatusesStillUsed(tx, workspaceId, id, definition)
    }
    if (patch.isDefault) await this.clearDefaultWorkflow(tx, workspaceId, current.projectId)
    const [row] = await tx
      .update(workflows)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
        ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
        definition,
        updatedAt: new Date(),
      })
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)))
      .returning()
    await this.announce(workspaceId, 'workflow', id, 'updated')
    return toWorkflow(row!)
  }

  /** Refuse to drop a status that issues still sit in — they would become unreachable. */
  private async assertStatusesStillUsed(
    tx: Tx,
    workspaceId: string,
    workflowId: string,
    next: WorkflowDefinition,
  ) {
    const known = new Set(next.statuses.map((s) => s.id))
    const typeRows = await tx
      .select({ id: workItemTypes.id })
      .from(workItemTypes)
      .where(and(eq(workItemTypes.workspaceId, workspaceId), eq(workItemTypes.workflowId, workflowId)))
    if (!typeRows.length) return

    // Count only the issues this workflow governs. Counting the whole workspace meant a status
    // belonging to some *other* workflow blocked this one from being edited.
    const rows = await tx
      .select({ statusId: issues.statusId, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          inArray(
            issues.typeId,
            typeRows.map((t) => t.id),
          ),
        ),
      )
      .groupBy(issues.statusId)
    const missing = rows.filter((r) => !known.has(r.statusId) && r.n > 0).map((r) => r.statusId)
    if (missing.length)
      throw KernError.conflict(
        `Statuses still in use: ${missing.join(', ')}`,
        'tracker.workflow.status_in_use',
      )
  }

  private async clearDefaultWorkflow(tx: Tx, workspaceId: string, projectId: string | null) {
    await tx
      .update(workflows)
      .set({ isDefault: false })
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          projectId ? eq(workflows.projectId, projectId) : isNull(workflows.projectId),
        ),
      )
  }

  async archiveWorkflow(tx: Tx, workspaceId: string, id: string, archived: boolean): Promise<Workflow> {
    const [row] = await tx
      .update(workflows)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Workflow')
    await this.announce(workspaceId, 'workflow', id, 'updated')
    return toWorkflow(row)
  }

  /** Row → contract shape, for the router. */
  toContractType(row: WorkItemTypeRow): WorkItemType {
    return toWorkItemType(row)
  }
  toContractWorkflow(row: WorkflowRow): Workflow {
    return toWorkflow(row)
  }

  /** Structural validation of a definition without saving it. */
  validate(definition: unknown): { ok: boolean; problems: Array<{ path: string; message: string }> } {
    const result = validateDefinition(definition, registryForValidation())
    return result.ok ? { ok: true, problems: [] } : { ok: false, problems: result.problems }
  }

  workflowTemplates(): Array<{ id: string; name: string; definition: WorkflowDefinition }> {
    return (Object.keys(workflowTemplates) as WorkflowTemplateId[]).map((id) => {
      const definition = createWorkflowFromTemplate(id, { id })
      return { id, name: definition.name, definition }
    })
  }

  // ------------------------------------------------------------------ workflow schemes

  async listWorkflowSchemes(tx: Tx, workspaceId: string): Promise<WorkflowScheme[]> {
    const rows = await tx
      .select()
      .from(workflowSchemes)
      .where(eq(workflowSchemes.workspaceId, workspaceId))
      .orderBy(asc(workflowSchemes.createdAt))
    return rows.map(toWorkflowScheme)
  }

  async createWorkflowScheme(
    tx: Tx,
    workspaceId: string,
    input: UpsertWorkflowScheme,
  ): Promise<WorkflowScheme> {
    const [row] = await tx
      .insert(workflowSchemes)
      .values({
        id: uuidv7(),
        workspaceId,
        name: input.name,
        defaultWorkflowId: input.defaultWorkflowId,
        mappings: input.mappings,
      })
      .returning()
    await this.announce(workspaceId, 'workflow_scheme', row!.id, 'created')
    return toWorkflowScheme(row!)
  }

  async updateWorkflowScheme(
    tx: Tx,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertWorkflowScheme>,
  ): Promise<WorkflowScheme> {
    const [row] = await tx
      .update(workflowSchemes)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.defaultWorkflowId === undefined ? {} : { defaultWorkflowId: patch.defaultWorkflowId }),
        ...(patch.mappings === undefined ? {} : { mappings: patch.mappings }),
        updatedAt: new Date(),
      })
      .where(and(eq(workflowSchemes.workspaceId, workspaceId), eq(workflowSchemes.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Workflow scheme')
    await this.announce(workspaceId, 'workflow_scheme', id, 'updated')
    return toWorkflowScheme(row)
  }

  async deleteWorkflowScheme(tx: Tx, workspaceId: string, id: string): Promise<void> {
    await tx.update(projects).set({ workflowSchemeId: null }).where(eq(projects.workflowSchemeId, id))
    await tx
      .delete(workflowSchemes)
      .where(and(eq(workflowSchemes.workspaceId, workspaceId), eq(workflowSchemes.id, id)))
    await this.announce(workspaceId, 'workflow_scheme', id, 'deleted')
  }

  // ------------------------------------------------------------------ resolution

  /**
   * The workflow an issue of `typeId` follows in `project`:
   * explicit type workflow → project's workflow scheme → project default → workspace default.
   */
  async workflowFor(
    tx: Tx,
    project: ProjectRow,
    typeId: string,
  ): Promise<{ workflowId: string; definition: WorkflowDefinition }> {
    const workspaceId = project.workspaceId
    const type = await this.getType(tx, workspaceId, typeId).catch(() => null)
    if (type?.workflowId) {
      const row = await this.getWorkflowRow(tx, workspaceId, type.workflowId).catch(() => null)
      if (row) return { workflowId: row.id, definition: row.definition as WorkflowDefinition }
    }
    if (project.workflowSchemeId) {
      const [scheme] = await tx
        .select()
        .from(workflowSchemes)
        .where(eq(workflowSchemes.id, project.workflowSchemeId))
        .limit(1)
      if (scheme) {
        const mappings = (scheme.mappings as Array<{ typeId: string; workflowId: string }>) ?? []
        const mapped = mappings.find((m) => m.typeId === typeId)?.workflowId ?? scheme.defaultWorkflowId
        const row = await this.getWorkflowRow(tx, workspaceId, mapped).catch(() => null)
        if (row) return { workflowId: row.id, definition: row.definition as WorkflowDefinition }
      }
    }
    const candidates = await tx
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          isNull(workflows.archivedAt),
          or(isNull(workflows.projectId), eq(workflows.projectId, project.id))!,
        ),
      )
      .orderBy(asc(workflows.createdAt))
    const chosen =
      candidates.find((w) => w.projectId === project.id && w.isDefault) ??
      candidates.find((w) => w.projectId === project.id) ??
      candidates.find((w) => w.isDefault) ??
      candidates[0]
    if (!chosen) throw KernError.badRequest('This project has no workflow')
    return { workflowId: chosen.id, definition: chosen.definition as WorkflowDefinition }
  }

  /** Every status of every workflow the project can use, deduplicated for board columns and KQL. */
  async statusesForProject(tx: Tx, workspaceId: string, projectId?: string): Promise<StatusInfo[]> {
    const filters = [eq(workflows.workspaceId, workspaceId), isNull(workflows.archivedAt)]
    if (projectId) filters.push(or(isNull(workflows.projectId), eq(workflows.projectId, projectId))!)
    const rows = await tx
      .select()
      .from(workflows)
      .where(and(...filters))
    const seen = new Map<string, StatusInfo>()
    for (const row of rows) {
      const definition = row.definition as WorkflowDefinition
      for (const [index, status] of sortedStatuses(definition).entries()) {
        if (seen.has(status.id)) continue
        seen.set(status.id, {
          id: status.id,
          name: status.name,
          category: status.category,
          color: status.color ?? null,
          order: status.order ?? index,
          workflowId: row.id,
        })
      }
    }
    return [...seen.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  // ------------------------------------------------------------------ seeding

  /** Create the workflow and types a brand-new project starts with. */
  async seedProject(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    template: string,
  ): Promise<{ workflowId: string; typeIds: string[]; defaultTypeId: string }> {
    const templateId = WORKFLOW_FOR_TEMPLATE[template] ?? 'simple'
    const workflowId = uuidv7()
    const definition = createWorkflowFromTemplate(templateId, { id: workflowId })
    await tx.insert(workflows).values({
      id: workflowId,
      workspaceId,
      projectId,
      name: definition.name,
      description: definition.description ?? null,
      definition,
      isDefault: true,
    })
    const seeds = TYPE_SEEDS[template] ?? TYPE_SEEDS.simple!
    const defaultKey = DEFAULT_TYPE_KEY[template] ?? 'task'
    const typeIds: string[] = []
    let defaultTypeId = ''
    for (const [order, seed] of seeds.entries()) {
      const id = uuidv7()
      typeIds.push(id)
      if (seed.key === defaultKey) defaultTypeId = id
      await tx.insert(workItemTypes).values({
        id,
        workspaceId,
        projectId,
        key: seed.key,
        name: seed.name,
        icon: seed.icon,
        level: seed.level,
        isDefault: seed.key === defaultKey,
        workflowId,
        order,
      })
    }
    return { workflowId, typeIds, defaultTypeId: defaultTypeId || typeIds[0]! }
  }

  /** Restore a project blueprint saved with `projects.templates.saveFromProject`. */
  async applyProjectTemplateBody(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ workflowId: string; defaultTypeId: string } | null> {
    const definitions = (body.workflows as WorkflowDefinition[] | undefined) ?? []
    const types =
      (body.types as Array<{
        key: string
        name: string
        level: number
        icon?: string | null
        color?: string | null
        isDefault?: boolean
        workflowIndex?: number
      }>) ?? []
    if (!definitions.length || !types.length) return null
    const workflowIds: string[] = []
    for (const definition of definitions) {
      const id = uuidv7()
      // Validate before reserving the index. Skipping an invalid definition after the push left
      // `workflowIndex` pointing at a workflow row that was never inserted, so every type in the
      // template mapped to nothing. A template that cannot be applied is an error, not a warning.
      const validated = validateDefinition({ ...definition, id }, registryForValidation())
      if (!validated.ok)
        throw KernError.badRequest(`Template workflow "${definition.name}" is not valid`, {
          problems: validated.problems,
        })
      workflowIds.push(id)
      await tx.insert(workflows).values({
        id,
        workspaceId,
        projectId,
        name: definition.name,
        definition: validated.definition,
        isDefault: workflowIds.length === 1,
      })
    }
    let defaultTypeId = ''
    for (const [order, type] of types.entries()) {
      const id = uuidv7()
      if (type.isDefault || !defaultTypeId) defaultTypeId = id
      await tx.insert(workItemTypes).values({
        id,
        workspaceId,
        projectId,
        key: type.key,
        name: type.name,
        icon: type.icon ?? null,
        color: type.color ?? null,
        level: type.level,
        isDefault: !!type.isDefault,
        workflowId: workflowIds[type.workflowIndex ?? 0] ?? workflowIds[0]!,
        order,
      })
    }
    return { workflowId: workflowIds[0]!, defaultTypeId }
  }

  /** Snapshot a project's configuration so another project can be created from it. */
  async snapshotProject(tx: Tx, workspaceId: string, projectId: string): Promise<Record<string, unknown>> {
    const typeRows = await tx
      .select()
      .from(workItemTypes)
      .where(and(eq(workItemTypes.workspaceId, workspaceId), eq(workItemTypes.projectId, projectId)))
      .orderBy(asc(workItemTypes.order))
    const workflowRows = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.projectId, projectId)))
    const workflowIndex = new Map(workflowRows.map((w, i) => [w.id, i]))
    const fieldRows = await tx
      .select()
      .from(fieldDefs)
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.projectId, projectId)))
    return {
      workflows: workflowRows.map((w) => w.definition),
      types: typeRows.map((t) => ({
        key: t.key,
        name: t.name,
        level: t.level,
        icon: t.icon,
        color: t.color,
        isDefault: t.isDefault,
        workflowIndex: t.workflowId ? (workflowIndex.get(t.workflowId) ?? 0) : 0,
      })),
      fields: fieldRows.map((f) => ({
        key: f.key,
        name: f.name,
        type: f.type,
        options: f.options,
        config: f.config,
      })),
    }
  }

  /** Ensure a set of type ids all belong to this workspace (scheme validation). */
  async assertTypesExist(tx: Tx, workspaceId: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    const rows = await tx
      .select({ id: workItemTypes.id })
      .from(workItemTypes)
      .where(and(eq(workItemTypes.workspaceId, workspaceId), inArray(workItemTypes.id, ids)))
    if (rows.length !== new Set(ids).size) throw KernError.badRequest('Unknown work item type in scheme')
  }

  /** Permission gate shared by every configuration mutation. */
  async requireWorkspacePermission(
    principal: Principal,
    workspaceId: string,
    permission: string,
  ): Promise<void> {
    void this.access
    await this.kernel.authz.require(principal, permission, {
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
    })
  }
}
