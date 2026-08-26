<script lang="ts">
import { Badge, Button, IconButton, Input, Spinner } from '@kernhq/ui'
import { t } from '../i18n.js'

/**
 * One list of small named things a project sorts work by: components, versions, labels.
 *
 * All three are the same shape — a name, something to say about it, and the ability to add, rename
 * and remove — so they share one list rather than three that drift. What differs is what each row
 * says beside its name, which the caller supplies.
 */
export interface PlanningItem {
  id: string
  name: string
  /** what this row says beside its name: a count, a date, a state */
  note?: string | null
  badge?: string | null
  color?: string | null
}

interface Props {
  title: string
  description: string
  items: PlanningItem[]
  loading?: boolean
  editable: boolean
  addLabel: string
  emptyLabel: string
  busy?: boolean
  onadd: (name: string) => void
  onrename: (id: string, name: string) => void
  onremove: (id: string) => void
  /** an extra action per row, when one exists (releasing a version) */
  rowAction?: { label: (item: PlanningItem) => string; run: (item: PlanningItem) => void }
}
let {
  title,
  description,
  items,
  loading = false,
  editable,
  addLabel,
  emptyLabel,
  busy = false,
  onadd,
  onrename,
  onremove,
  rowAction,
}: Props = $props()

let adding = $state('')
let editingId = $state<string | null>(null)
let draft = $state('')
/** Named on screen before it happens, never behind `window.confirm`. */
let confirmingId = $state<string | null>(null)

const submit = () => {
  const name = adding.trim()
  if (!name || busy) return
  onadd(name)
  adding = ''
}

const startEdit = (item: PlanningItem) => {
  editingId = item.id
  draft = item.name
}

const commitEdit = () => {
  const id = editingId
  const name = draft.trim()
  editingId = null
  if (id && name) onrename(id, name)
}
</script>

<section class="plist" data-testid="planning-{title.toLowerCase().replace(/\s+/g, '-')}">
  <header>
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  </header>

  {#if loading}
    <div class="state"><Spinner /></div>
  {:else if !items.length && !editable}
    <p class="empty">{emptyLabel}</p>
  {:else}
    <ul>
      {#each items as item (item.id)}
        <li>
          {#if item.color}<span class="swatch" style:background={item.color}></span>{/if}
          {#if editingId === item.id}
            <Input
              value={draft}
              oninput={(e: Event) => (draft = (e.currentTarget as HTMLInputElement).value)}
              onblur={commitEdit}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') editingId = null
              }}
            />
          {:else}
            <button
              type="button"
              class="name"
              disabled={!editable}
              onclick={() => startEdit(item)}
              data-item={item.name}
            >
              {item.name}
            </button>
          {/if}
          {#if item.badge}<Badge>{item.badge}</Badge>{/if}
          {#if item.note}<span class="note">{item.note}</span>{/if}
          {#if editable && rowAction}
            <Button size="sm" variant="ghost" onclick={() => rowAction.run(item)}>
              {rowAction.label(item)}
            </Button>
          {/if}
          {#if editable}
            <IconButton
              icon="x"
              size={22}
              label={t('planning_remove', { name: item.name })}
              onclick={() => (confirmingId = item.id)}
            />
          {/if}
        </li>
        {#if confirmingId === item.id}
          <!-- The role sits on a child rather than on the `<li>`: a list item is non-interactive,
               and Svelte refuses an interactive role on one. `.confirm` moves with it and now
               declares its own `display: flex` — it had been borrowing the `<li>`'s. -->
          <li>
            <div class="confirm" role="alertdialog" aria-label={t('planning_remove_body', { name: item.name })}>
              <span>{t('planning_remove_body', { name: item.name })}</span>
              <Button size="sm" variant="danger" onclick={() => { onremove(item.id); confirmingId = null }}>
                {t('common.delete')}
              </Button>
              <Button size="sm" variant="ghost" onclick={() => (confirmingId = null)}>{t('common.cancel')}</Button>
            </div>
          </li>
        {/if}
      {:else}
        <li class="empty-row">{emptyLabel}</li>
      {/each}
    </ul>

    {#if editable}
      <!-- The button carries its own handler rather than relying on the form: `Button` renders
           `type="button"`, so a submit would depend on how its props happen to spread. -->
      <form class="add" onsubmit={(e) => { e.preventDefault(); submit() }}>
        <Input
          bind:value={adding}
          placeholder={addLabel}
          data-testid="planning-add"
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <Button size="sm" disabled={!adding.trim() || busy} onclick={submit}>{t('common.add')}</Button>
      </form>
    {/if}
  {/if}
</section>

<style>
.plist {
  padding: 14px 0;
  border-bottom: 1px solid var(--kern-border-hairline);
}
.plist:last-child {
  border-bottom: 0;
}
h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
header p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--kern-ink-400);
}
ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex: none;
}
.name {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  margin-inline-start: -6px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name:disabled {
  cursor: default;
}
.name:not(:disabled):hover {
  background: var(--kern-surface-hover);
}
.note {
  font-size: 12px;
  color: var(--kern-ink-400);
}
.confirm {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.empty,
.empty-row {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--kern-ink-400);
}
.add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.state {
  display: grid;
  place-items: center;
  padding: 18px;
}
</style>
