<script lang="ts">
import { Button, Dialog, Icon, Input, Textarea, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { ProjectTemplate } from '../index.js'
import { trackerKeys } from '../query.js'

/**
 * Making a project, and choosing the shape it starts in.
 *
 * The template is the only decision here that is hard to change later: it seeds the work item
 * types, the fields and the layouts, and those become what everyone on the project sees. So it is
 * the part of this dialog that gets the room, and each option says what it is for rather than what
 * it contains.
 */
interface Props {
  open: boolean
  workspaceId: string
  onclose: () => void
  oncreated: (key: string) => void
}
let { open, workspaceId, onclose, oncreated }: Props = $props()

const api = getTrackerApi()
const queryClient = useQueryClient()

let name = $state('')
let key = $state('')
let description = $state('')
let templateId = $state('software')
let keyEdited = $state(false)

const templatesQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'templates'],
  queryFn: () => api.projects.templates.list({ workspaceId }),
  enabled: open && Boolean(workspaceId),
}))
const templates = $derived(templatesQuery.data ?? [])

$effect(() => {
  if (!open) return
  name = ''
  key = ''
  description = ''
  templateId = 'software'
  keyEdited = false
})

/** `Kern Platform` → `KERN`: initials for several words, the first letters for one. */
const suggestKey = (value: string) => {
  const words = value.trim().split(/\s+/).filter(Boolean)
  const raw = words.length > 1 ? words.map((w) => w[0] ?? '').join('') : (words[0] ?? '').slice(0, 4)
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10)
}

$effect(() => {
  if (!keyEdited) key = suggestKey(name)
})

const keyValid = $derived(/^[A-Z][A-Z0-9]{1,9}$/.test(key))
const valid = $derived(Boolean(name.trim()) && keyValid)

const create = createMutation(() => ({
  mutationFn: () => {
    const chosen = templates.find((tpl) => tpl.id === templateId)
    return api.projects.create({
      workspaceId,
      name: name.trim(),
      key,
      description: description.trim() || null,
      // A built-in is named; anything the workspace saved is referenced by id.
      ...(chosen?.builtin === false ? { templateId } : { template: templateId }),
    } as never)
  },
  onSuccess: (project: { key: string }) => {
    void queryClient.invalidateQueries({ queryKey: trackerKeys.projects(workspaceId) })
    oncreated(project.key)
    onclose()
  },
  onError: (error: Error) => toast.error(error.message),
}))
</script>

<Dialog
  {open}
  title={t('project_new')}
  size="lg"
  onOpenChange={(next: boolean) => {
    if (!next) onclose()
  }}
>
  <div class="grid gap-3">
    <div class="two">
      <label class="grid gap-1">
        <span class="lbl">{t('project_name')}</span>
        <Input bind:value={name} placeholder="Kern Platform" data-testid="project-name" />
      </label>
      <label class="grid gap-1">
        <span class="lbl">{t('project_key')}</span>
        <Input
          bind:value={key}
          oninput={() => (keyEdited = true)}
          placeholder="KERN"
          data-testid="project-key"
        />
        <span class="hint" class:bad={key.length > 0 && !keyValid}>{t('project_key_hint')}</span>
      </label>
    </div>

    <label class="grid gap-1">
      <span class="lbl">{t('project_description')}</span>
      <Textarea bind:value={description} rows={2} />
    </label>

    <fieldset class="grid gap-1">
      <legend class="lbl">{t('project_template')}</legend>
      <span class="hint">{t('project_template_hint')}</span>
      <ul class="templates" data-testid="template-choices">
        {#each templates as template (template.id)}
          <li>
            <button
              type="button"
              class="tpl"
              class:on={templateId === template.id}
              aria-pressed={templateId === template.id}
              onclick={() => (templateId = template.id)}
              data-template={template.key}
            >
              <span class="tname">
                {template.name}
                {#if templateId === template.id}<Icon name="check" size={13} strokeWidth={2} />{/if}
              </span>
              {#if template.description}<span class="tdesc">{template.description}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </fieldset>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={onclose}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      disabled={!valid}
      loading={create.isPending}
      onclick={() => create.mutate()}
      data-testid="project-create"
    >
      {t('project_create')}
    </Button>
  {/snippet}
</Dialog>

<style>
.lbl {
  font-size: 12px;
  color: var(--kern-ink-550);
}
.hint {
  display: block;
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
.hint.bad {
  color: var(--kern-danger);
}
.two {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 10px;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.templates {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /* every card is the same size whatever its description costs in lines: `1fr` rows make each row
     as tall as the tallest card in the grid, and the `li` stretches its button to fill the cell —
     without it a two-line description left the card beside it visibly short. */
  grid-auto-rows: 1fr;
  gap: 8px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.templates > li {
  display: grid;
}
@media (max-width: 560px) {
  .templates {
    grid-template-columns: 1fr;
  }
}
.tpl {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.tpl:hover {
  background: var(--kern-surface-hover);
}
.tpl.on {
  border-color: var(--kern-accent);
  background: var(--kern-info-tint);
}
.tname {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
.tdesc {
  font-size: 12px;
  color: var(--kern-ink-450, var(--kern-ink-400));
}
</style>
