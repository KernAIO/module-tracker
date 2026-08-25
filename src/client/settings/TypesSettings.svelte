<script lang="ts">
import {
  Badge,
  Button,
  Checkbox,
  Icon,
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
import type { FieldLayoutItem, WorkItemType } from '../index.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import LayoutEditor from './LayoutEditor.svelte'
import TypeEditor from './TypeEditor.svelte'

/**
 * Work item types, and what each one shows.
 *
 * This is where the layout that `types.layout` resolves is actually written. Everything else in the
 * tracker reads it: the issue panel, the create dialog, and the cards.
 *
 * A workspace can also add its own types here. Until it could, the per-type customisation this page
 * exists for only reached the four types a template happened to seed — a support desk could arrange
 * "Bug" but never have an "Incident".
 */
const api = getTrackerApi()
const queryClient = useQueryClient()

const slug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === slug)?.id ?? '')
const canManage = $derived(canTracker('typeManage'))

let selectedId = $state<string | null>(null)
/** The arrangement in progress. `null` means "unchanged", which is what disables Save. */
let draft = $state<FieldLayoutItem[] | null>(null)
/** The type being created or edited: `undefined` is closed, `null` is a new one. */
let editorFor = $state<WorkItemType | null | undefined>(undefined)
let archivingId = $state<string | null>(null)
let showArchived = $state(false)

const typesQuery = createQuery(() => ({
  queryKey: [...trackerKeys.types(workspaceId), showArchived],
  queryFn: () => api.types.list({ workspaceId, includeArchived: showArchived }),
  enabled: Boolean(workspaceId),
}))
const types = $derived(typesQuery.data ?? [])
const selected = $derived(types.find((type) => type.id === selectedId) ?? types[0] ?? null)

const layoutQuery = createQuery(() => ({
  queryKey: trackerKeys.layout(workspaceId, selected?.id ?? '', null),
  queryFn: () => api.types.layout({ workspaceId, id: selected?.id as string, projectId: null }),
  enabled: Boolean(selected?.id),
}))

const save = createMutation(() => ({
  mutationFn: (items: FieldLayoutItem[]) =>
    api.types.update({
      workspaceId,
      id: selected?.id as string,
      // A `$state` array is a deep proxy, and a proxy cannot be structured-cloned or posted as-is.
      patch: { fieldLayout: $state.snapshot(items) as FieldLayoutItem[] },
    }),
  onSuccess: () => {
    draft = null
    void queryClient.invalidateQueries({ queryKey: ['tracker', 'type', workspaceId] })
    toast.success(t('layout_saved'))
  },
  onError: (error: Error) => toast.error(error.message),
}))

const refreshTypes = () => queryClient.invalidateQueries({ queryKey: ['tracker', 'type', workspaceId] })

/**
 * The rules that decide what may sit under what.
 *
 * These were enforced and unreachable, which is the worst combination: somebody adding a sub-item
 * got "Sub-items may only nest 1 level(s) deep" from the server with nowhere to go and change it.
 * They live here because they are about types and their levels, which is what this page is.
 */
const rulesQuery = createQuery(() => ({
  queryKey: [...trackerKeys.types(workspaceId), 'hierarchy'],
  queryFn: () => api.types.hierarchyRules({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const rules = $derived(rulesQuery.data ?? null)

const saveRules = createMutation(() => ({
  mutationFn: (next: NonNullable<typeof rules>) => api.types.setHierarchyRules({ workspaceId, rules: next }),
  onSuccess: () => {
    void refreshTypes()
    toast.success(t('hierarchy_saved'))
  },
  onError: (error: Error) => toast.error(error.message),
}))
const setRule = (patch: Record<string, unknown>) => {
  if (rules) saveRules.mutate({ ...rules, ...patch } as NonNullable<typeof rules>)
}

const saveType = createMutation(() => ({
  mutationFn: (input: Record<string, unknown>) =>
    editorFor
      ? api.types.update({ workspaceId, id: editorFor.id, patch: input })
      : api.types.create({ workspaceId, ...input } as never),
  onSuccess: (saved: WorkItemType) => {
    editorFor = undefined
    selectedId = saved.id
    draft = null
    void refreshTypes()
    toast.success(t('type_saved'))
  },
  onError: (error: Error) => toast.error(error.message),
}))

/**
 * Archived, never deleted. Issues keep pointing at their type, so removing one would leave work
 * with no answer to "what is this" — archiving takes it off every menu and leaves the past intact.
 */
const archiveType = createMutation(() => ({
  mutationFn: (input: { id: string; archived: boolean }) => api.types.archive({ workspaceId, ...input }),
  onSuccess: () => {
    archivingId = null
    void refreshTypes()
  },
  onError: (error: Error) => toast.error(error.message),
}))

/** Switching type abandons an unsaved arrangement rather than carrying it onto another type. */
const select = (type: WorkItemType) => {
  selectedId = type.id
  draft = null
}
</script>

<SettingsPage title={t('settings_types')} description={t('settings_types_hint')}>
  {#if typesQuery.isPending}
    <SettingsSection><div class="state"><Spinner /></div></SettingsSection>
  {:else if typesQuery.isError}
    <SettingsSection>
      <div class="state">
        <p>{t('settings_types_failed')}</p>
        <Button size="sm" variant="ghost" onclick={() => typesQuery.refetch()}>{t('common.retry')}</Button>
      </div>
    </SettingsSection>
  {:else}
    <SettingsSection flush>
      <ul class="types" data-testid="type-list">
        {#each types as type (type.id)}
          <li class:archived={type.archivedAt} class:on={selected?.id === type.id}>
            <button
              type="button"
              class="trow"
              onclick={() => select(type)}
              data-testid="type-row"
              data-type-key={type.key}
            >
              <Icon name={type.icon ?? 'square-check-big'} size={14} strokeWidth={1.8} />
              <span class="tname">{type.name}</span>
              <span class="tkey">{type.key}</span>
              {#if type.isDefault}<Badge>{t('type_default')}</Badge>{/if}
              {#if type.archivedAt}<Badge tone="grey">{t('type_archived')}</Badge>{/if}
              {#if type.fieldLayout.length}<Badge tone="info">{t('type_customised')}</Badge>{/if}
            </button>
            {#if canManage}
              <div class="tactions">
                <Button size="sm" variant="ghost" onclick={() => (editorFor = type)} data-testid="type-edit">
                  {t('common.edit')}
                </Button>
                {#if type.archivedAt}
                  <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => archiveType.mutate({ id: type.id, archived: false })}
                  >
                    {t('type_restore')}
                  </Button>
                {:else}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={type.isDefault}
                    onclick={() => (archivingId = type.id)}
                    data-testid="type-archive"
                  >
                    {t('common.archive')}
                  </Button>
                {/if}
              </div>
            {/if}
          </li>
          {#if archivingId === type.id}
            <li class="confirm">
              <div role="alertdialog" aria-label={t('type_archive_body', { name: type.name })}>
                <span>{t('type_archive_body', { name: type.name })}</span>
                <Button
                  size="sm"
                  onclick={() => archiveType.mutate({ id: type.id, archived: true })}
                  data-testid="type-archive-confirm"
                >
                  {t('common.archive')}
                </Button>
                <Button size="sm" variant="ghost" onclick={() => (archivingId = null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </li>
          {/if}
        {/each}
      </ul>

      {#snippet footer()}
        <Checkbox
          checked={showArchived}
          label={t('type_show_archived')}
          onCheckedChange={(on: boolean) => (showArchived = on)}
        />
        <Button size="sm" disabled={!canManage} onclick={() => (editorFor = null)} data-testid="type-new">
          {t('type_new')}
        </Button>
      {/snippet}
    </SettingsSection>

    {#if rules}
      <SettingsSection
        title={t('hierarchy_title')}
        description={t('hierarchy_hint')}
      >
        <div class="rules">
          <Checkbox
            checked={rules.allowSameLevel}
            label={t('hierarchy_same_level')}
            disabled={!canManage}
            onCheckedChange={(on: boolean) => setRule({ allowSameLevel: on })}
          />
          <Checkbox
            checked={rules.allowSkipLevels}
            label={t('hierarchy_skip_levels')}
            disabled={!canManage}
            onCheckedChange={(on: boolean) => setRule({ allowSkipLevels: on })}
          />
          <label class="drow" data-testid="hierarchy-depth">
            <span class="dlbl">{t('hierarchy_depth')}</span>
            <Select
              value={String(rules.maxSubItemDepth)}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
              disabled={!canManage}
              onValueChange={(v: string) => setRule({ maxSubItemDepth: Number(v) })}
            />
          </label>
        </div>
      </SettingsSection>
    {/if}

    {#if selected}
      <SettingsSection
        title={t('layout_for', { name: selected.name })}
        description={t('layout_hint')}
      >
        {#if layoutQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if layoutQuery.data}
          <LayoutEditor
            layout={layoutQuery.data}
            disabled={!canManage}
            onchange={(items) => (draft = items)}
          />
        {/if}

        {#snippet footer()}
          <Button variant="ghost" size="sm" onclick={() => (draft = null)} disabled={!draft}>
            {t('common.discard')}
          </Button>
          <Button
            size="sm"
            disabled={!draft || !canManage}
            loading={save.isPending}
            onclick={() => draft && save.mutate(draft)}
            data-testid="save-layout"
          >
            {t('common.save')}
          </Button>
        {/snippet}
      </SettingsSection>
    {/if}
  {/if}
</SettingsPage>

<TypeEditor
  open={editorFor !== undefined}
  type={editorFor ?? null}
  busy={saveType.isPending}
  onclose={() => (editorFor = undefined)}
  onsave={(input) => saveType.mutate(input)}
/>

<style>
.rules {
  display: grid;
  gap: 10px;
  justify-items: start;
}
.drow {
  display: grid;
  gap: 4px;
}
.dlbl {
  font-size: 12px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.state {
  display: grid;
  place-items: center;
  gap: 8px;
  padding: 28px;
  font-size: 13px;
}
.types {
  list-style: none;
  margin: 0;
  padding: 0;
}
.types li {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--kern-border-hairline);
}
.types li.archived .tname {
  color: var(--kern-ink-400);
}
.tactions {
  display: flex;
  gap: 2px;
  padding-inline-end: 12px;
}
.confirm {
  padding: 8px 18px;
  font-size: 12.5px;
}
.confirm div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.types li:last-child {
  border-bottom: 0;
}
.trow {
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
.trow:hover {
  background: var(--kern-surface-hover);
}
.types li.on {
  background: var(--kern-surface-active);
}
.tname {
  font-size: 13px;
  color: var(--kern-ink-800);
}
.tkey {
  flex: 1;
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
</style>
