<script lang="ts">
import {
  Avatar,
  Button,
  coreApi,
  Dialog,
  DropdownMenu,
  EmptyState,
  IconButton,
  Input,
  keys,
  type MenuItem,
  Select,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import type { CoreApi } from '../core-api.js'
import { t } from '../i18n.js'
import type { Component } from '../index.js'
import { projectKql, trackerHref } from '../nav.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { useRouteProject } from './context.svelte.js'
import ProjectShell from './ProjectShell.svelte'

/**
 * A project's components: the parts of the thing being built.
 *
 * A row per part, with who looks after it and how much work is filed against it — and the row is a
 * link into that work, because a component is only ever interesting as the issues in it. New work
 * given a component can be assigned to its lead by default, which is the whole reason a component
 * has one; the settings screen could set neither.
 */
const api = getTrackerApi()
const core = coreApi<CoreApi>()
const queryClient = useQueryClient()

const at = useRouteProject()
const slug = $derived(at.slug)
const workspaceId = $derived(at.workspaceId)
const projectId = $derived(at.projectId)
const canManage = $derived(canTracker('projectManage'))

const componentsQuery = createQuery(() => ({
  queryKey: trackerKeys.components(workspaceId, projectId),
  queryFn: () => api.components.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
const components = $derived(componentsQuery.data ?? [])

const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
/** `members.list` is paged; the picker wants people, not the envelope. */
const members = $derived(
  (membersQuery.data?.items ?? []).map((member) => ({
    id: member.user.id,
    name: member.user.name,
    avatarUrl: member.user.avatarUrl,
  })),
)
const memberOf = (id: string | null) => members.find((member) => member.id === id) ?? null

const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'component'] })
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] })
}
const fail = (error: Error) => toast.error(error.message)

let editing = $state<Component | null>(null)
let creating = $state(false)
let draftName = $state('')
let draftDescription = $state('')
let draftLead = $state('')
let draftAssignee = $state<'none' | 'lead' | 'project'>('none')
/** Named on screen before it happens, never straight off a menu. */
let confirming = $state<Component | null>(null)

const open = (component: Component | null) => {
  editing = component
  creating = component === null
  draftName = component?.name ?? ''
  draftDescription = component?.description ?? ''
  draftLead = component?.leadId ?? ''
  draftAssignee = component?.defaultAssignee ?? 'none'
}
const close = () => {
  editing = null
  creating = false
}

const save = createMutation(() => ({
  mutationFn: () => {
    const patch = {
      name: draftName.trim(),
      description: draftDescription.trim() || null,
      leadId: draftLead || null,
      defaultAssignee: draftAssignee,
    }
    return editing
      ? api.components.update({ workspaceId, id: editing.id, patch })
      : api.components.create({ workspaceId, projectId, ...patch })
  },
  onSuccess: () => {
    close()
    invalidate()
  },
  onError: fail,
}))

const remove = createMutation(() => ({
  mutationFn: (id: string) => api.components.delete({ workspaceId, id }),
  onSuccess: () => {
    confirming = null
    invalidate()
  },
  onError: fail,
}))

/** The work filed against one component, as the query the issue list already understands. */
const issuesHref = (component: Component) =>
  trackerHref(slug, { q: `${projectKql(projectId)} and component = ${JSON.stringify(component.id)}` })

const assigneeOptions = $derived([
  { value: 'none', label: t('project_assignee_nobody') },
  { value: 'lead', label: t('component_assignee_lead') },
  { value: 'project', label: t('component_assignee_project') },
])

const menuFor = (component: Component): MenuItem[] => [
  {
    type: 'item',
    id: 'issues',
    label: t('component_issues'),
    icon: 'list',
    href: issuesHref(component),
  },
  ...(canManage
    ? [
        { type: 'separator' as const },
        {
          type: 'item' as const,
          id: 'edit',
          label: t('common.edit'),
          icon: 'pencil',
          onSelect: () => open(component),
        },
        {
          type: 'item' as const,
          id: 'delete',
          label: t('common.delete'),
          icon: 'trash-2',
          danger: true,
          onSelect: () => (confirming = component),
        },
      ]
    : []),
]
</script>

<ProjectShell
  project={at.project}
  pending={at.pending}
  failed={at.failed}
  onretry={at.retry}
  {slug}
  projectKey={at.projectKey}
  title={t('planning_components')}
  subtitle={t('components_count', { count: components.length })}
>
  {#snippet headerActions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={() => open(null)} data-testid="component-new">
        {t('component_new')}
      </Button>
    {/if}
  {/snippet}

  {#snippet children()}
    {#if componentsQuery.isPending}
      <p class="quiet">{t('common.loading')}</p>
    {:else if componentsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('error_title')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void componentsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if !components.length}
      <EmptyState
        icon="puzzle"
        title={t('planning_components_empty')}
        description={t('planning_components_hint')}
      >
        {#snippet actions()}
          {#if canManage}
            <Button size="sm" icon="plus" onclick={() => open(null)}>{t('component_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table" data-testid="component-table">
        <div class="head">
          <span>{t('planning_components')}</span>
          <span>{t('component_lead')}</span>
          <span class="num">{t('component_issues')}</span>
          <span></span>
        </div>
        {#each components as component (component.id)}
          {@const lead = memberOf(component.leadId)}
          <div class="row" data-item={component.name}>
            <a class="what" href={issuesHref(component)}>
              <span class="name">{component.name}</span>
              {#if component.description}<span class="rule">{component.description}</span>{/if}
            </a>
            <span class="lead">
              {#if lead}
                <Avatar id={lead.id} name={lead.name} src={lead.avatarUrl} size={22} />
                <span class="who">{lead.name}</span>
              {:else}
                <span class="none">{t('project_no_lead')}</span>
              {/if}
            </span>
            <span class="num count">{t('planning_issue_count', { count: component.issueCount })}</span>
            <DropdownMenu items={menuFor(component)} align="end">
              {#snippet trigger(props)}
                <IconButton
                  {...props}
                  icon="ellipsis"
                  size={26}
                  label={t('component_actions', { name: component.name })}
                />
              {/snippet}
            </DropdownMenu>
          </div>
        {/each}
      </div>
    {/if}
  {/snippet}
</ProjectShell>

<Dialog
  open={creating || editing !== null}
  title={editing ? t('component_edit') : t('component_new')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) close()
  }}
>
  <div class="form">
    <label class="frow">
      <span class="lbl">{t('project_name')}</span>
      <Input bind:value={draftName} data-testid="component-name" />
    </label>
    <label class="frow">
      <span class="lbl">{t('project_description')}</span>
      <Textarea bind:value={draftDescription} rows={2} data-testid="component-description" />
    </label>
    <div class="frow">
      <span class="lbl">{t('component_lead')}</span>
      <Select
        value={draftLead}
        options={[
          { value: '', label: t('project_no_lead') },
          ...members.map((member) => ({ value: member.id, label: member.name ?? member.id })),
        ]}
        onValueChange={(value: string) => (draftLead = value)}
      />
    </div>
    <div class="frow">
      <span class="lbl">{t('component_assignee')}</span>
      <Select
        value={draftAssignee}
        options={assigneeOptions}
        onValueChange={(value: string) => (draftAssignee = value as typeof draftAssignee)}
      />
    </div>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={close}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      disabled={!draftName.trim()}
      loading={save.isPending}
      onclick={() => save.mutate()}
      data-testid="component-save"
    >
      {t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<Dialog
  open={confirming !== null}
  title={t('planning_remove', { name: confirming?.name ?? '' })}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) confirming = null
  }}
>
  <p class="body">{t('planning_remove_body', { name: confirming?.name ?? '' })}</p>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={() => (confirming = null)}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      variant="danger"
      loading={remove.isPending}
      onclick={() => confirming && remove.mutate(confirming.id)}
      data-testid="component-delete-confirm"
    >
      {t('common.delete')}
    </Button>
  {/snippet}
</Dialog>

<style>
/* A table in the shape of the issue list's rows (DESIGN.md 3.1/3.2): a header of sub-labels, then
   44px rows that light up under the pointer. */
.table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  background: var(--kern-surface-raised);
  overflow: hidden;
}
.head,
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px 96px 34px;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
}
.head {
  height: 34px;
  background: var(--kern-surface-header);
  border-bottom: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-450);
}
.row {
  min-height: 46px;
  border-bottom: 1px solid var(--kern-border-hairline);
}
.row:last-child {
  border-bottom: none;
}
.row:hover {
  background: var(--kern-surface-hover);
}
.what {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  text-decoration: none;
  padding: 8px 0;
}
.name {
  font-size: 14px;
  color: var(--kern-ink-800);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.what:hover .name {
  text-decoration: underline;
}
.rule {
  font-size: 12.5px;
  color: var(--kern-ink-400);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.who {
  font-size: 13px;
  color: var(--kern-ink-650);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.none {
  font-size: 12.5px;
  color: var(--kern-ink-350);
}
.num {
  text-align: end;
}
.count {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-350);
}
.quiet {
  margin: 0;
  font-size: 13px;
  color: var(--kern-ink-400);
}
.form {
  display: grid;
  gap: 12px;
}
.frow {
  display: grid;
  gap: 4px;
}
.lbl {
  font-size: 12px;
  color: var(--kern-ink-550);
}
.body {
  margin: 0;
  font-size: 13px;
}
</style>
