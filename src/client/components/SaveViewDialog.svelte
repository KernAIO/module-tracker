<script lang="ts">
import { Button, Dialog, Input, Select, toast } from '@kernhq/ui'
import { createMutation, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'

/**
 * Naming the query you are looking at.
 *
 * The view captures what the page is showing — the KQL, the layout and the grouping — because that
 * is what somebody means by "this view". Anything they change afterwards is a different view until
 * they save it again.
 *
 * When the page is already showing a saved view, saving offers to change that view as well as to
 * make a new one. Without the first, refining a view you had saved silently produced a second copy
 * of it, and a sidebar filled with "My bugs 2".
 */
interface Props {
  open: boolean
  workspaceId: string
  kql: string
  layout: 'list' | 'board'
  groupBy: string
  /** the saved view the page is showing, when it is showing one you may change */
  editing?: { id: string; name: string } | null
  onclose: () => void
}
let { open, workspaceId, kql, layout, groupBy, editing = null, onclose }: Props = $props()

const api = getTrackerApi()
const queryClient = useQueryClient()

let name = $state('')
let visibility = $state<'private' | 'project' | 'workspace'>('private')

$effect(() => {
  if (!open) return
  name = ''
  visibility = 'private'
})

/** Sharing a view with other people is a permission; keeping one for yourself is not. */
const canShare = $derived(canTracker('viewManageShared'))
const options = $derived([
  { value: 'private', label: t('view_private') },
  ...(canShare
    ? [
        { value: 'project', label: t('view_project') },
        { value: 'workspace', label: t('view_workspace') },
      ]
    : []),
])

const done = (view: { name: string }) => {
  void queryClient.invalidateQueries({ queryKey: trackerKeys.views(workspaceId) })
  toast.success(t('view_saved', { name: view.name }))
  onclose()
}

/** Changing the view that is open: the same query the page is showing, under the same name. */
const update = createMutation(() => ({
  mutationFn: () =>
    api.views.update({
      workspaceId,
      id: editing?.id as string,
      patch: { kql, layout, display: { groupBy } },
    } as never),
  onSuccess: done,
  onError: (error: Error) => toast.error(error.message),
}))

const save = createMutation(() => ({
  mutationFn: () =>
    api.views.create({
      workspaceId,
      name: name.trim(),
      kql,
      layout,
      display: { groupBy },
      visibility,
    } as never),
  onSuccess: done,
  onError: (error: Error) => toast.error(error.message),
}))
</script>

<Dialog
  {open}
  title={editing ? t('view_save_changes') : t('view_save')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) onclose()
  }}
>
  <div class="grid gap-3">
    <label class="grid gap-1">
      <span class="lbl">{t('view_name')}</span>
      <Input bind:value={name} placeholder="My open bugs" data-testid="view-name" />
    </label>
    <label class="grid gap-1">
      <span class="lbl">{t('view_visibility')}</span>
      <Select
        value={visibility}
        {options}
        onValueChange={(v: string) => (visibility = v as typeof visibility)}
      />
    </label>
    <p class="preview" data-testid="view-preview">{kql || t('all_issues')}</p>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={onclose}>{t('common.cancel')}</Button>
    {#if editing}
      <Button
        variant="ghost"
        size="sm"
        loading={update.isPending}
        onclick={() => update.mutate()}
        data-testid="view-update"
      >
        {t('view_update', { name: editing.name })}
      </Button>
    {/if}
    <Button
      size="sm"
      disabled={!name.trim()}
      loading={save.isPending}
      onclick={() => save.mutate()}
      data-testid="view-save"
    >
      {editing ? t('view_save_as_new') : t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<style>
.lbl {
  font-size: 12px;
  color: var(--kern-ink-550);
}
.preview {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--kern-r-sm);
  background: var(--kern-shell);
  font-family: var(--kern-font-mono);
  font-size: 12px;
  color: var(--kern-ink-450, var(--kern-ink-400));
  overflow-wrap: anywhere;
}
</style>
