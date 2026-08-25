<script lang="ts">
import { Checkbox, DropdownMenu, IconButton, type MenuItem } from '@kernhq/ui'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import type { FieldDef } from '../index.js'
import IssueInline from './IssueInline.svelte'
import IssuePicker from './IssuePicker.svelte'

/**
 * One custom field, rendered and edited according to its type.
 *
 * Every field type the server accepts has a branch here. A type with no editor yet renders its
 * value read-only and says why, rather than showing a control that silently does nothing.
 *
 * The value is committed on blur or on selection, never on every keystroke: each edit is its own
 * mutation, and a request per character would be both slow and impossible to reason about when one
 * of them fails.
 */
interface Props {
  field: FieldDef
  value: unknown
  editable: boolean
  required?: boolean
  /** needed by the relation picker, which searches the workspace's issues */
  workspaceId: string
  /** the issue being edited, so a relation never offers to link it to itself */
  issueId?: string | null
  onchange: (value: unknown) => void
}
let { field, value, editable, required = false, workspaceId, issueId = null, onchange }: Props = $props()

/** Open only while somebody is choosing, so the row stays a row the rest of the time. */
let picking = $state(false)

const cat = getTrackerCatalogue()

const asText = $derived(typeof value === 'string' ? value : value == null ? '' : String(value))
const asArray = $derived(Array.isArray(value) ? (value as string[]) : value == null ? [] : [String(value)])

const options = $derived(field.options.filter((o) => !o.archived))
const optionLabel = (id: string) => options.find((o) => o.id === id)?.label ?? id
const personName = (id: string) => cat.people.find((p) => p.id === id)?.name ?? id

/** Empty string means "no value", which is a deletion — `null` is how the API says that. */
const commit = (next: unknown) => {
  if (next === '' || (Array.isArray(next) && next.length === 0)) onchange(null)
  else onchange(next)
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...list.filter((v) => v !== id), id] : list.filter((v) => v !== id)

const selectMenu = $derived<MenuItem[]>([
  ...options.map((o) => ({
    type: 'checkbox' as const,
    id: o.id,
    label: o.label,
    checked: asText === o.id,
    onCheckedChange: (on: boolean) => commit(on ? o.id : null),
  })),
])

const multiSelectMenu = $derived<MenuItem[]>(
  options.map((o) => ({
    type: 'checkbox' as const,
    id: o.id,
    label: o.label,
    checked: asArray.includes(o.id),
    onCheckedChange: (on: boolean) => commit(toggle(asArray, o.id, on)),
  })),
)

const userMenu = $derived<MenuItem[]>(
  cat.people.map((person) => ({
    type: 'checkbox' as const,
    id: person.id,
    label: person.name,
    avatar: { id: person.id, name: person.name, src: person.avatarUrl },
    checked: field.type === 'user' ? asText === person.id : asArray.includes(person.id),
    onCheckedChange: (on: boolean) =>
      field.type === 'user' ? commit(on ? person.id : null) : commit(toggle(asArray, person.id, on)),
  })),
)

const dateValue = $derived(field.type === 'datetime' && asText ? asText.slice(0, 16) : asText.slice(0, 10))
</script>

{#if field.type === 'textarea'}
  <!-- Bare rather than the boxed `Textarea`: a property row shows its value inline and only looks
       like a control while you are in it (DESIGN.md 3.13). -->
  <textarea
    class="val-input"
    value={asText}
    rows="2"
    disabled={!editable}
    {required}
    placeholder={editable ? t('field_empty') : ''}
    aria-label={field.name}
    onblur={(e) => commit(e.currentTarget.value)}
  ></textarea>
{:else if field.type === 'number' || field.type === 'text' || field.type === 'url'}
  <input
    class="val-input"
    value={asText}
    type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
    disabled={!editable}
    {required}
    min={field.config.min}
    max={field.config.max}
    maxlength={field.config.maxLength}
    placeholder={editable ? (field.type === 'url' ? 'https://' : t('field_empty')) : ''}
    aria-label={field.name}
    onblur={(e) => {
      const raw = e.currentTarget.value
      commit(field.type === 'number' ? (raw === '' ? null : Number(raw)) : raw)
    }}
  />
{:else if field.type === 'checkbox'}
  <Checkbox
    checked={value === true}
    disabled={!editable}
    ariaLabel={field.name}
    onCheckedChange={(on: boolean) => onchange(on)}
  />
{:else if field.type === 'date' || field.type === 'datetime'}
  <input
    class="date"
    type={field.type === 'datetime' ? 'datetime-local' : 'date'}
    value={dateValue}
    disabled={!editable}
    {required}
    aria-label={field.name}
    onchange={(e) => commit(e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : null)}
  />
{:else if field.type === 'select' || field.type === 'multiselect' || field.type === 'label'}
  {@const many = field.type !== 'select'}
  <DropdownMenu items={editable ? (many ? multiSelectMenu : selectMenu) : []} align="start">
    {#snippet trigger(props)}
      <button
        {...props}
        type="button"
        class="val wrap"
        class:static={!editable}
        disabled={!editable}
        title={editable ? undefined : t('no_permission')}>
        {#if many ? asArray.length === 0 : !asText}
          <span class="muted">{t('field_empty')}</span>
        {:else if many}
          {#each asArray as id (id)}
            <span class="chip">{optionLabel(id)}</span>
          {/each}
        {:else}
          {optionLabel(asText)}
        {/if}
      </button>
    {/snippet}
  </DropdownMenu>
{:else if field.type === 'user' || field.type === 'multiuser'}
  {@const many = field.type === 'multiuser'}
  <DropdownMenu items={editable ? userMenu : []} align="start">
    {#snippet trigger(props)}
      <button
        {...props}
        type="button"
        class="val wrap"
        class:static={!editable}
        disabled={!editable}
        title={editable ? undefined : t('no_permission')}>
        {#if many ? asArray.length === 0 : !asText}
          <span class="muted">{t('field_empty')}</span>
        {:else if many}
          {#each asArray as id (id)}
            <span class="chip">{personName(id)}</span>
          {/each}
        {:else}
          {personName(asText)}
        {/if}
      </button>
    {/snippet}
  </DropdownMenu>
{:else if field.type === 'formula'}
  <span class="val static" title={t('field_formula_hint')}>
    {#if value === null || value === undefined}
      <span class="muted">{t('field_empty')}</span>
    {:else}
      {String(value)}
    {/if}
  </span>
{:else if field.type === 'relation'}
  <div class="rel">
    {#if asArray.length}
      <ul class="links">
        {#each asArray as id (id)}
          <li>
            <IssueInline {id} />
            {#if editable}
              <IconButton
                icon="x"
                size={22}
                label={t('relation_unlink')}
                onclick={() => commit(asArray.filter((v) => v !== id))}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if editable}
      {#if picking}
        <IssuePicker
          {workspaceId}
          exclude={[...asArray, ...(issueId ? [issueId] : [])]}
          placeholder={t('relation_link')}
          onpick={(issue) => {
            // `relationMultiple: false` means one link, so a new pick replaces rather than appends.
            commit(field.config.relationMultiple === false ? [issue.id] : [...asArray, issue.id])
            picking = false
          }}
          oncancel={() => (picking = false)}
        />
      {:else if field.config.relationMultiple !== false || asArray.length === 0}
        <button type="button" class="link-btn" onclick={() => (picking = true)}>
          {t('relation_link')}
        </button>
      {/if}
    {:else if !asArray.length}
      <span class="muted">{t('field_empty')}</span>
    {/if}
  </div>
{/if}
<style>
.val-input,
.date {
  width: 100%;
  min-height: 24px;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border: 1px solid transparent;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  resize: vertical;
}
.val-input:hover:not(:disabled),
.date:hover:not(:disabled) {
  background: var(--kern-surface-active);
}
.val-input:focus,
.date:focus {
  border-color: var(--kern-border);
  background: var(--kern-surface);
  outline: none;
}
.val-input:disabled,
.date:disabled {
  cursor: default;
}
.val-input::placeholder {
  color: var(--kern-ink-350);
}
.chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--kern-surface-active);
  font-size: 12px;
}
.muted {
  color: var(--kern-ink-350);
}
.rel {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.links li {
  display: flex;
  align-items: center;
  gap: 4px;
}
.link-btn {
  align-self: flex-start;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-350);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.link-btn:hover {
  background: var(--kern-surface-active);
  color: var(--kern-ink-900);
}
.val {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 6px;
  margin-inline-start: -6px;
  border-radius: var(--kern-r-sm);
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;
}
.val.wrap {
  flex-wrap: wrap;
}
.val:hover:not(.static) {
  background: var(--kern-surface-active);
}
.val.static {
  cursor: default;
}
</style>
