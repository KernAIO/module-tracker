<script lang="ts">
import {
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  IconButton,
  Input,
  type MenuItem,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { IssueTemplate } from '../index.js'
import { projectTargets, trackerHref } from '../nav.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { useRouteProject } from './context.svelte.js'
import ProjectShell from './ProjectShell.svelte'

/**
 * A project's issue templates: the starting point for work somebody raises again and again.
 *
 * `issues.templates.create` has existed since the module did and nothing ever called it, so the one
 * screen that listed templates could only delete them. A template is a name, what the issue it
 * raises is called, and the note that goes in its description.
 */
const api = getTrackerApi()
const queryClient = useQueryClient()

const at = useRouteProject()
const slug = $derived(at.slug)
const workspaceId = $derived(at.workspaceId)
const projectId = $derived(at.projectId)
const canManage = $derived(canTracker('projectManage'))
const canCreate = $derived(canTracker('create'))

const templatesQuery = createQuery(() => ({
  queryKey: trackerKeys.issueTemplates(workspaceId, projectId),
  queryFn: () => api.issues.templates.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
const templates = $derived(templatesQuery.data ?? [])

const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue-template'] })
const fail = (error: Error) => toast.error(error.message)

let editing = $state<IssueTemplate | null>(null)
let creating = $state(false)
let draftName = $state('')
let draftTitle = $state('')
let draftBody = $state('')
/** Named on screen before it happens, never straight off a menu. */
let confirming = $state<IssueTemplate | null>(null)

const open = (template: IssueTemplate | null) => {
  editing = template
  creating = template === null
  draftName = template?.name ?? ''
  draftTitle = (template?.defaults?.title as string | undefined) ?? ''
  draftBody = template?.description ?? ''
}
const close = () => {
  editing = null
  creating = false
}

const save = createMutation(() => ({
  mutationFn: () => {
    const name = draftName.trim()
    // Without a title of its own the issue starts with the template's name, which is what somebody
    // means by "Incident review" far more often than an empty title.
    const body = {
      name,
      description: draftBody.trim() || null,
      defaults: { title: draftTitle.trim() || name },
    }
    return editing
      ? api.issues.templates.update({ workspaceId, id: editing.id, patch: body } as never)
      : api.issues.templates.create({ workspaceId, projectId, ...body } as never)
  },
  onSuccess: () => {
    close()
    invalidate()
  },
  onError: fail,
}))

const remove = createMutation(() => ({
  mutationFn: (id: string) => api.issues.templates.delete({ workspaceId, id }),
  onSuccess: () => {
    confirming = null
    invalidate()
  },
  onError: fail,
}))

const menuFor = (template: IssueTemplate): MenuItem[] =>
  canManage
    ? [
        { type: 'item', id: 'edit', label: t('common.edit'), icon: 'pencil', onSelect: () => open(template) },
        {
          type: 'item',
          id: 'delete',
          label: t('common.delete'),
          icon: 'trash-2',
          danger: true,
          onSelect: () => (confirming = template),
        },
      ]
    : []

/** Raising one: the issue dialog opens on this project, with the list it belongs to underneath. */
const newIssueHref = $derived(
  projectId ? `${trackerHref(slug, projectTargets(projectId).issues)}&new=1&project=${projectId}` : '',
)
</script>

<ProjectShell
  project={at.project}
  pending={at.pending}
  {slug}
  projectKey={at.projectKey}
  title={t('template_title')}
  subtitle={t('templates_count', { count: templates.length })}
>
  {#snippet headerActions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={() => open(null)} data-testid="template-new">
        {t('template_new')}
      </Button>
    {/if}
  {/snippet}

  {#snippet children()}
    {#if templatesQuery.isPending}
      <p class="quiet">{t('common.loading')}</p>
    {:else if !templates.length}
      <EmptyState icon="copy" title={t('template_empty')} description={t('template_hint')}>
        {#snippet actions()}
          {#if canManage}
            <Button size="sm" icon="plus" onclick={() => open(null)}>{t('template_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="list" data-testid="template-list">
        {#each templates as template (template.id)}
          <article class="card" data-item={template.name}>
            <div class="what">
              <h3>{template.name}</h3>
              {#if template.defaults?.title}
                <p class="starts">{t('template_starts', { title: template.defaults.title })}</p>
              {/if}
              {#if template.description}<p class="note">{template.description}</p>{/if}
              {#if template.subItems.length}
                <span class="chip">{t('template_subitems', { count: template.subItems.length })}</span>
              {/if}
            </div>
            <div class="acts">
              {#if canCreate}
                <Button size="xs" variant="secondary" href={newIssueHref}>{t('template_use')}</Button>
              {/if}
              {#if menuFor(template).length}
                <DropdownMenu items={menuFor(template)} align="end">
                  {#snippet trigger(props)}
                    <IconButton
                      {...props}
                      icon="ellipsis"
                      size={26}
                      label={t('template_actions', { name: template.name })}
                    />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {/snippet}
</ProjectShell>

<Dialog
  open={creating || editing !== null}
  title={editing ? t('template_edit') : t('template_new')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) close()
  }}
>
  <div class="form">
    <label class="frow">
      <span class="lbl">{t('template_name')}</span>
      <Input bind:value={draftName} data-testid="template-name" />
    </label>
    <label class="frow">
      <span class="lbl">{t('template_issue_title')}</span>
      <Input bind:value={draftTitle} data-testid="template-title" />
    </label>
    <label class="frow">
      <span class="lbl">{t('project_description')}</span>
      <Textarea bind:value={draftBody} rows={3} data-testid="template-body" />
    </label>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={close}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      disabled={!draftName.trim()}
      loading={save.isPending}
      onclick={() => save.mutate()}
      data-testid="template-save"
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
      data-testid="template-delete-confirm"
    >
      {t('common.delete')}
    </Button>
  {/snippet}
</Dialog>

<style>
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  background: var(--kern-surface-raised);
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  padding: 14px 16px;
}
.what {
  flex: 1;
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
.starts {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--kern-ink-500);
}
.note {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--kern-ink-450);
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  margin-top: 10px;
  padding: 0 9px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
  color: var(--kern-ink-500);
  font-size: 12px;
}
.acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
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
