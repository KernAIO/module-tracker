<script lang="ts">
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  navigation,
  Select,
  SettingsPage,
  SettingsSection,
  Spinner,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { StatusCategory, Workflow, WorkflowDefinition } from '../index.js'
import { describeApprovers, describeRule } from '../index.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'

/**
 * Workflows: the statuses work moves through, and what each move requires.
 *
 * The statuses are editable here. The transitions are shown rather than edited — every one of them
 * carries conditions, validators and post-functions, and a graph editor for those is its own piece
 * of work. What matters first is that they stop being invisible: a workflow's rules decided who
 * could close an issue and nobody could read them.
 *
 * A workflow starts from one of the three the server ships rather than from nothing. An empty
 * workflow has no transitions, so no work could ever move through it — offering "blank" would be
 * offering a broken thing.
 */
const api = getTrackerApi()
const queryClient = useQueryClient()

const slug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === slug)?.id ?? '')
const canManage = $derived(canTracker('workflowManage'))

let selectedId = $state<string | null>(null)
/** The statuses being edited, or `null` when nothing has been touched — which is what gates Save. */
let draft = $state<WorkflowDefinition['statuses'] | null>(null)
let adding = $state('')
let addingCategory = $state<StatusCategory>('todo')
let newOpen = $state(false)
let newName = $state('')
let newTemplate = $state('software')
let removingId = $state<string | null>(null)
/** What the server said about the arrangement in progress; `[]` once it has said nothing is wrong. */
let problems = $state<Array<{ path: string; message: string }>>([])
/** Transitions a newly added status needs; they join the definition only when it is saved. */
let pendingTransitions = $state<WorkflowDefinition['transitions']>([])

const workflowsQuery = createQuery(() => ({
  queryKey: [...trackerKeys.types(workspaceId), 'workflows'],
  queryFn: () => api.workflows.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const typesQuery = createQuery(() => ({
  queryKey: trackerKeys.types(workspaceId),
  queryFn: () => api.types.list({ workspaceId, includeArchived: false }),
  enabled: Boolean(workspaceId),
}))

const templatesQuery = createQuery(() => ({
  queryKey: ['tracker', 'workflow-template'],
  queryFn: () => api.workflows.templates({}),
  enabled: Boolean(workspaceId),
}))

const workflows = $derived(workflowsQuery.data ?? [])
const selected = $derived(workflows.find((w) => w.id === selectedId) ?? workflows[0] ?? null)
const statuses = $derived(draft ?? selected?.definition.statuses ?? [])

/**
 * The definition as it would be saved.
 *
 * Removing a status has to take its transitions with it: a transition naming a status that is no
 * longer there fails validation, and the message an admin would see names a path index rather than
 * the status they just removed.
 */
const nextDefinition = $derived.by(() => {
  if (!selected) return null
  const ids = new Set(statuses.map((st) => st.id))
  return {
    ...selected.definition,
    statuses: statuses.map((st, order) => ({ ...st, order })),
    transitions: [...selected.definition.transitions, ...pendingTransitions]
      .filter((rule) => ids.has(rule.to) && (rule.from === '*' || rule.from.some((f) => ids.has(f))))
      .map((rule) => (rule.from === '*' ? rule : { ...rule, from: rule.from.filter((f) => ids.has(f)) })),
  }
})
/** Which work item types this workflow governs — the reason editing it is not a local decision. */
const usedBy = $derived((typesQuery.data ?? []).filter((type) => type.workflowId === selected?.id))

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: trackerKeys.types(workspaceId) })
  void queryClient.invalidateQueries({ queryKey: trackerKeys.statuses(workspaceId) })
}

/**
 * Checked by the server before it is saved, not after it is rejected.
 *
 * The rules live in `@kernhq/workflow` and the same call the server makes on save is available on
 * its own — so the page can say what is wrong in the workflow's own terms instead of turning a
 * rejected save into a toast.
 *
 * Note what it does not check: whether a status can be reached. That is why adding one wires it in
 * rather than leaving it floating.
 */
const save = createMutation(() => ({
  mutationFn: async (definition: WorkflowDefinition) => {
    const check = await api.workflows.validate({ workspaceId, definition })
    if (!check.ok) {
      problems = check.problems
      throw new Error(t('workflow_invalid'))
    }
    problems = []
    return api.workflows.update({ workspaceId, id: selected!.id, patch: { definition } } as never)
  },
  onSuccess: () => {
    draft = null
    pendingTransitions = []
    refresh()
    toast.success(t('workflow_saved'))
  },
  onError: (error: Error) => toast.error(error.message),
}))

const createWorkflow = createMutation(() => ({
  mutationFn: () => {
    const template = (templatesQuery.data ?? []).find((tpl) => tpl.id === newTemplate)
    if (!template) throw new Error(t('workflow_no_template'))
    return api.workflows.create({
      workspaceId,
      name: newName.trim(),
      definition: template.definition,
    } as never)
  },
  onSuccess: (created: Workflow) => {
    newOpen = false
    newName = ''
    selectedId = created.id
    draft = null
    refresh()
  },
  onError: (error: Error) => toast.error(error.message),
}))

const archiveWorkflow = createMutation(() => ({
  mutationFn: (input: { id: string; archived: boolean }) => api.workflows.archive({ workspaceId, ...input }),
  onSuccess: refresh,
  onError: (error: Error) => toast.error(error.message),
}))

/**
 * Which types run on this workflow.
 *
 * Creating a workflow means nothing until something uses it, and the type is what points at one —
 * so the link is made here, where the workflow is, rather than left to be found on another screen.
 */
const setTypeWorkflow = createMutation(() => ({
  mutationFn: (input: { typeId: string; workflowId: string | null }) =>
    api.types.update({ workspaceId, id: input.typeId, patch: { workflowId: input.workflowId } }),
  onSuccess: refresh,
  onError: (error: Error) => toast.error(error.message),
}))

const select = (workflow: Workflow) => {
  selectedId = workflow.id
  draft = null
  problems = []
  removingId = null
  pendingTransitions = []
}

const rename = (id: string, name: string) => {
  draft = statuses.map((s) => (s.id === id ? { ...s, name } : s))
}

/**
 * A status nothing can move into is a status that does not exist, and validation does not catch
 * it — so a new one is wired in on both sides: work reaches it from anywhere, and leaves it for
 * anywhere. Permissive on purpose. A status that is too open is a rule to tighten later; one that
 * traps work is a support ticket.
 */
const addStatus = () => {
  const name = adding.trim()
  if (!name || !selected) return
  const id = `st_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${statuses.length}`
  draft = [...statuses, { id, name, category: addingCategory, order: statuses.length }]
  // Every array present: a transition missing `validators` is not "no validators" to the contract,
  // it is an incomplete transition, and the definition fails to parse.
  const empty = { conditions: [], validators: [], postFunctions: [], hidden: false }
  const into = { id: `tr_into_${id}`, name, from: '*' as const, to: id, ...empty }
  const outOf = statuses.map((st) => ({
    id: `tr_${id}_${st.id}`,
    name: st.name,
    from: [id],
    to: st.id,
    ...empty,
  }))
  pendingTransitions = [...pendingTransitions, into, ...outOf]
  adding = ''
}

/** Removing takes the transitions with it, here and in `nextDefinition`; the server refuses if
 * any work is still sitting in the status, and says so. */
const removeStatus = (id: string) => {
  draft = statuses.filter((st) => st.id !== id)
  pendingTransitions = pendingTransitions.filter(
    (rule) => rule.to !== id && (rule.from === '*' || !rule.from.includes(id)),
  )
  removingId = null
}
const move = (index: number, by: number) => {
  const next = [...statuses]
  const target = index + by
  if (target < 0 || target >= next.length) return
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  draft = next
}

const CATEGORIES: StatusCategory[] = ['triage', 'backlog', 'todo', 'in_progress', 'done', 'cancelled']
const CATEGORY_LABELS: Record<StatusCategory, () => string> = {
  triage: () => t('cat_triage'),
  backlog: () => t('cat_backlog'),
  todo: () => t('cat_todo'),
  in_progress: () => t('cat_in_progress'),
  done: () => t('cat_done'),
  cancelled: () => t('cat_cancelled'),
}
const categoryLabel = (c: StatusCategory) => CATEGORY_LABELS[c]?.() ?? c

const statusName = (id: string) => statuses.find((s) => s.id === id)?.name ?? id
const from = (rule: { from: string | string[] }) =>
  rule.from === '*' ? t('workflow_from_any') : (rule.from as string[]).map(statusName).join(', ')
</script>

<SettingsPage title={t('settings_workflows')} description={t('settings_workflows_hint')}>
  {#if workflowsQuery.isPending}
    <SettingsSection><div class="state"><Spinner /></div></SettingsSection>
  {:else if workflowsQuery.isError}
    <SettingsSection>
      <div class="state">
        <p>{t('error_title')}</p>
        <Button size="sm" variant="ghost" onclick={() => void workflowsQuery.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    </SettingsSection>
  {:else if !workflows.length}
    <SettingsSection><p class="state">{t('settings_workflows_empty')}</p></SettingsSection>
  {:else}
    <SettingsSection flush>
      <ul class="wlist" data-testid="workflow-list">
        {#each workflows as workflow (workflow.id)}
          <li>
            <button
              type="button"
              class="wrow"
              class:on={selected?.id === workflow.id}
              onclick={() => select(workflow)}
              data-workflow={workflow.name}
            >
              <span class="wname">{workflow.name}</span>
              <span class="wmeta">{t('workflow_status_count', { count: workflow.definition.statuses.length })}</span>
              {#if workflow.isDefault}<Badge>{t('type_default')}</Badge>{/if}
            </button>
            {#if canManage && !workflow.isDefault}
              <Button
                size="sm"
                variant="ghost"
                onclick={() => archiveWorkflow.mutate({ id: workflow.id, archived: true })}
              >
                {t('common.archive')}
              </Button>
            {/if}
          </li>
        {/each}
      </ul>

      {#snippet footer()}
        <Button size="sm" disabled={!canManage} onclick={() => (newOpen = true)} data-testid="workflow-new">
          {t('workflow_new')}
        </Button>
      {/snippet}
    </SettingsSection>

    {#if selected}
      <!-- Every section below names the workflow it belongs to. The list is at the top of a page
           that scrolls well past it, so by the time you reach Save the only thing telling you which
           workflow you are editing has scrolled away. -->
      <SettingsSection
        title={t('workflow_statuses_in', { name: selected.name })}
        description={t('workflow_statuses_hint')}
      >
        <ul class="statuses" data-testid="workflow-statuses">
          {#each statuses as status, i (status.id)}
            <li>
              <span class="ord">{i + 1}</span>
              {#if canManage}
                <Input
                  value={status.name}
                  aria-label={t('status_name')}
                  data-status={status.id}
                  oninput={(e: Event) => rename(status.id, (e.currentTarget as HTMLInputElement).value)}
                />
                <!-- The category, not the name, is what a board column and every report count by,
                     so it is shown beside the name rather than hidden in the definition. Fixed
                     width, or the buttons after it sit in a ragged column. -->
                <span class="cat"><Badge tone="grey">{categoryLabel(status.category)}</Badge></span>
                <IconButton
                  icon="chevron-up"
                  size={22}
                  label={t('workflow_move_up', { name: status.name })}
                  disabled={i === 0}
                  onclick={() => move(i, -1)}
                />
                <IconButton
                  icon="chevron-down"
                  size={22}
                  label={t('workflow_move_down', { name: status.name })}
                  disabled={i === statuses.length - 1}
                  onclick={() => move(i, 1)}
                />
                <IconButton
                  icon="x"
                  size={22}
                  label={t('workflow_remove_status', { name: status.name })}
                  disabled={statuses.length < 2}
                  onclick={() => (removingId = status.id)}
                />
              {:else}
                <span class="sname">{status.name}</span>
                <span class="cat"><Badge tone="grey">{categoryLabel(status.category)}</Badge></span>
              {/if}
            </li>
            {#if removingId === status.id}
              <li class="confirm">
                <div role="alertdialog" aria-label={t('workflow_remove_body')}>
                  <span>{t('workflow_remove_body')}</span>
                  <Button size="sm" variant="danger" onclick={() => removeStatus(status.id)}>
                    {t('common.remove')}
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => (removingId = null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </li>
            {/if}
          {/each}
        </ul>

        {#if canManage}
          <form class="addrow" onsubmit={(e) => { e.preventDefault(); addStatus() }}>
            <Input bind:value={adding} placeholder={t('workflow_status_add')} data-testid="status-add" />
            <Select
              value={addingCategory}
              options={CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
              onValueChange={(v: string) => (addingCategory = v as StatusCategory)}
            />
            <Button size="sm" disabled={!adding.trim()} onclick={addStatus} data-testid="status-add-go">
              {t('common.add')}
            </Button>
          </form>
          <p class="note">{t('workflow_status_add_hint')}</p>
        {/if}

        {#if problems.length}
          <ul class="problems" data-testid="workflow-problems">
            {#each problems as problem (problem.path + problem.message)}
              <li>{problem.path}: {problem.message}</li>
            {/each}
          </ul>
        {/if}

        <div class="usedby">
          <p class="lbl">{t('workflow_used_by_in', { name: selected.name })}</p>
          {#each typesQuery.data ?? [] as type (type.id)}
            <Checkbox
              checked={type.workflowId === selected.id}
              label={type.name}
              disabled={!canManage}
              onCheckedChange={(on: boolean) =>
                setTypeWorkflow.mutate({ typeId: type.id, workflowId: on ? selected.id : null })}
            />
          {/each}
          {#if !usedBy.length}
            <p class="note">{t('workflow_used_by_none')}</p>
          {/if}
        </div>

        {#snippet footer()}
          <Button variant="ghost" size="sm" onclick={() => (draft = null)} disabled={!draft}>
            {t('common.discard')}
          </Button>
          <Button
            size="sm"
            disabled={!draft || !canManage}
            loading={save.isPending}
            onclick={() => nextDefinition && save.mutate(nextDefinition)}
            data-testid="save-workflow"
          >
            {t('common.save')}
          </Button>
        {/snippet}
      </SettingsSection>

      <SettingsSection
        title={t('workflow_transitions_in', { name: selected.name })}
        description={t('workflow_transitions_hint')}
      >
        <ul class="transitions" data-testid="workflow-transitions">
          {#each selected.definition.transitions as transition (transition.id)}
            <li>
              <div class="thead">
                <strong>{transition.name}</strong>
                <span class="path">
                  {from(transition)}
                  <Icon name="arrow-right" size={12} strokeWidth={1.8} />
                  {statusName(transition.to)}
                </span>
              </div>
              <ul class="rules">
                {#if transition.approval}
                  <li class="rule approval">
                    {describeApprovers(
                      transition.approval.approvers,
                      transition.approval.minApprovals ?? 1,
                    )}
                  </li>
                {/if}
                {#each [...(transition.conditions ?? []), ...(transition.validators ?? []), ...(transition.postFunctions ?? [])] as rule, i (rule.type + i)}
                  {@const described = describeRule(rule)}
                  <li class="rule" class:unknown={described.unknown}>{described.text}</li>
                {/each}
                {#if transition.screen?.fields?.length}
                  <li class="rule">
                    {t('workflow_asks', { count: transition.screen.fields.length })}
                  </li>
                {/if}
              </ul>
            </li>
          {/each}
        </ul>
      </SettingsSection>
    {/if}
  {/if}
</SettingsPage>

<Dialog
  open={newOpen}
  title={t('workflow_new')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) newOpen = false
  }}
>
  <div class="ngrid">
    <label class="nrow">
      <span class="lbl">{t('workflow_name')}</span>
      <Input bind:value={newName} placeholder="Support" data-testid="workflow-name" />
    </label>
    <label class="nrow">
      <span class="lbl">{t('workflow_start_from')}</span>
      <Select
        value={newTemplate}
        options={(templatesQuery.data ?? []).map((tpl) => ({ value: tpl.id, label: tpl.name }))}
        onValueChange={(v: string) => (newTemplate = v)}
      />
      <span class="note">{t('workflow_start_from_hint')}</span>
    </label>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={() => (newOpen = false)}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      disabled={!newName.trim()}
      loading={createWorkflow.isPending}
      onclick={() => createWorkflow.mutate()}
      data-testid="workflow-create"
    >
      {t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<style>
.cat {
  flex: none;
  min-width: 88px;
}
.addrow {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kern-ink-400);
}
.problems {
  list-style: none;
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--kern-danger);
  border-radius: var(--kern-r-sm);
  font-size: 12px;
  color: var(--kern-danger);
}
.confirm {
  padding: 6px 0;
  font-size: 12.5px;
}
.confirm div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.usedby {
  display: grid;
  gap: 6px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--kern-border-hairline);
}
.lbl {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.ngrid {
  display: grid;
  gap: 12px;
}
.nrow {
  display: grid;
  gap: 4px;
}
.state {
  display: grid;
  place-items: center;
  gap: 8px;
  padding: 26px;
  font-size: 13px;
}
.wlist,
.statuses,
.transitions,
.rules {
  list-style: none;
  margin: 0;
  padding: 0;
}
.wlist li {
  border-bottom: 1px solid var(--kern-border-hairline);
}
.wlist li:last-child {
  border-bottom: 0;
}
.wrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 18px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.wrow:hover {
  background: var(--kern-surface-hover);
}
.wrow.on {
  background: var(--kern-surface-active);
}
.wname {
  font-size: 13px;
  color: var(--kern-ink-800);
}
.wmeta {
  flex: 1;
  font-size: 12px;
  color: var(--kern-ink-400);
}
.statuses li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.ord {
  width: 18px;
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
.sname {
  font-size: 13px;
}
.transitions > li {
  padding: 10px 0;
  border-bottom: 1px solid var(--kern-border-hairline);
}
.transitions > li:last-child {
  border-bottom: 0;
}
.thead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.path {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--kern-ink-450, var(--kern-ink-400));
}
.rules {
  margin-top: 4px;
}
.rule {
  font-size: 12.5px;
  color: var(--kern-ink-550);
  padding: 1px 0 1px 10px;
  border-inline-start: 2px solid var(--kern-border);
  margin-inline-start: 2px;
}
.rule.approval {
  border-color: var(--kern-warning);
}
.rule.unknown {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
</style>
