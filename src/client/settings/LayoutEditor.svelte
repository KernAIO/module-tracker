<script lang="ts">
import { DropdownMenu, Icon, IconButton, type MenuItem } from '@kernhq/ui'
import { untrack } from 'svelte'
import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action'
import { t } from '../i18n.js'
import type { FieldLayoutItem, ResolvedField, ResolvedLayout } from '../index.js'

/**
 * Where each field sits on a work item type: the main column, the sidebar, or hidden.
 *
 * Three drop zones over `svelte-dnd-action`, with both lessons the board taught: `$state.raw`,
 * because a deep-reactive proxy hands the drag library a different object on every read and it
 * reads that as an endless stream of changes; and a `dragging` guard, so a refetch cannot yank the
 * lists out from under a drag in progress.
 *
 * Pinned fields render locked. An issue without a title, a status or a type is not an issue.
 */
interface Props {
  layout: ResolvedLayout
  disabled?: boolean
  onchange: (items: FieldLayoutItem[]) => void
}
let { layout, disabled = false, onchange }: Props = $props()

type Zone = 'main' | 'sidebar' | 'hidden'
/**
 * `svelte-dnd-action` tracks items by an `id` property and nothing else. A `ResolvedField` is keyed
 * by `fieldId`, so without this the zones look populated and refuse to move anything at all —
 * silently, by mouse and by keyboard alike.
 */
type Draggable = ResolvedField & { id: string }
const draggable = (field: ResolvedField): Draggable => ({ ...field, id: field.fieldId })
const ZONES: Array<{ id: Zone; label: () => string; hint: () => string }> = [
  { id: 'main', label: () => t('layout_main'), hint: () => t('layout_main_hint') },
  { id: 'sidebar', label: () => t('layout_sidebar'), hint: () => t('layout_sidebar_hint') },
  { id: 'hidden', label: () => t('layout_hidden'), hint: () => t('layout_hidden_hint') },
]

let columns = $state.raw<Record<Zone, Draggable[]>>({ main: [], sidebar: [], hidden: [] })
let dragging = $state(false)

/**
 * Seed the zones from the resolved layout, and *only* from it.
 *
 * `dragging` is read through `untrack` on purpose: reading it normally makes it a dependency, so
 * clearing it at the end of a drop re-runs this effect, which re-seeds the zones from the server's
 * layout and undoes the move on screen — while the change that was already emitted is still
 * pending. The screen and the unsaved change would disagree.
 */
$effect(() => {
  const next = layout
  untrack(() => {
    if (dragging) return
    columns = {
      main: next.main.map(draggable),
      sidebar: next.sidebar.map(draggable),
      hidden: next.hidden.map(draggable),
    }
  })
})

const isShadow = (field: Draggable) =>
  (field as unknown as Record<string, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true

/** The whole arrangement as the contract stores it: one entry per field, in the order shown. */
function emit(next: Record<Zone, Draggable[]>) {
  const items: FieldLayoutItem[] = []
  for (const zone of ['main', 'sidebar', 'hidden'] as Zone[])
    for (const [index, field] of next[zone].entries()) {
      if (isShadow(field)) continue
      items.push({
        fieldId: field.fieldId,
        section: zone,
        order: index,
        required: field.required && !field.pinned,
        hidden: zone === 'hidden',
      })
    }
  onchange(items)
}

/**
 * Move a field without dragging.
 *
 * A drag is a fine gesture and a poor requirement: it is unreachable by keyboard and by anyone who
 * cannot hold a pointer steady. Every arrangement possible by dragging is possible here too.
 */
function moveTo(field: Draggable, to: Zone) {
  const next: Record<Zone, Draggable[]> = {
    main: columns.main.filter((f) => f.id !== field.id),
    sidebar: columns.sidebar.filter((f) => f.id !== field.id),
    hidden: columns.hidden.filter((f) => f.id !== field.id),
  }
  // A pinned field is never hidden, whatever route asked for it.
  const target = to === 'hidden' && field.pinned ? 'sidebar' : to
  next[target] = [...next[target], field]
  columns = next
  emit(next)
}

const moveMenu = (field: Draggable, from: Zone): MenuItem[] =>
  ZONES.filter((z) => z.id !== from && !(z.id === 'hidden' && field.pinned)).map((z) => ({
    type: 'item' as const,
    id: z.id,
    label: t('layout_move_to', { zone: z.label() }),
    onSelect: () => moveTo(field, z.id),
  }))

function consider(zone: Zone, event: CustomEvent<{ items: Draggable[] }>) {
  dragging = true
  columns = { ...columns, [zone]: event.detail.items }
}

function finalize(zone: Zone, event: CustomEvent<{ items: Draggable[] }>) {
  let next = { ...columns, [zone]: event.detail.items }
  // A pinned field that somehow reached `hidden` goes back to the sidebar. Enforcing it here rather
  // than refusing the drop covers every route in — drag, keyboard, a stored layout written by hand.
  if (zone === 'hidden') {
    const stowaways = next.hidden.filter((f) => f.pinned)
    if (stowaways.length)
      next = {
        ...next,
        hidden: next.hidden.filter((f) => !f.pinned),
        sidebar: [...next.sidebar, ...stowaways],
      }
  }
  columns = next
  dragging = false
  emit(next)
}
</script>

<div class="zones">
  {#each ZONES as zone (zone.id)}
    <section class="zone">
      <header>
        <span class="kern-sublabel">{zone.label()}</span>
        <span class="hint">{zone.hint()}</span>
      </header>
      <ul
        class="drop"
        class:empty={columns[zone.id].length === 0}
        data-testid="zone-{zone.id}"
        use:dndzone={{
          items: columns[zone.id],
          dragDisabled: disabled,
          dropFromOthersDisabled: disabled,
          flipDurationMs: 120,
          dropTargetStyle: {},
        }}
        onconsider={(e) => consider(zone.id, e)}
        onfinalize={(e) => finalize(zone.id, e)}
      >
        {#each columns[zone.id] as field (field.id)}
          <li class:pinned={field.pinned} data-field-id={field.fieldId}>
            <Icon name={field.pinned ? 'lock' : 'menu'} size={13} strokeWidth={1.8} />
            <span class="label">{field.label}</span>
            {#if field.kind === 'custom'}
              <span class="key">cf.{field.field?.key}</span>
            {/if}
            {#if field.required}
              <span class="req" title={t('field_required')}>*</span>
            {/if}
            {#if !disabled}
              <DropdownMenu items={moveMenu(field, zone.id)} align="end">
                {#snippet trigger(props)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    size={22}
                    label={t('layout_move', { field: field.label })}
                  />
                {/snippet}
              </DropdownMenu>
            {/if}
          </li>
        {/each}
        {#if columns[zone.id].length === 0}
          <li class="placeholder">{t('layout_drop_here')}</li>
        {/if}
      </ul>
    </section>
  {/each}
</div>

<style>
.zones {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 720px) {
  .zones {
    grid-template-columns: 1fr;
  }
}
header {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 6px;
}
.hint {
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
.drop {
  list-style: none;
  margin: 0;
  padding: 6px;
  /* an empty zone still has to be a target, so it keeps a height of its own */
  min-height: 96px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px dashed var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-shell);
}
.drop li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  font-size: 13px;
  cursor: grab;
}
.drop li.pinned {
  cursor: default;
  /*
   * Muted by colour, not by `opacity`. A row at 0.75 fades its text against the page it sits on —
   * the required marker inside it dropped to 3.2:1, which is a readability failure rather than a
   * visual hint — and opacity fades everything by the same amount whatever its starting contrast.
   */
  color: var(--kern-ink-450);
}
.drop li.placeholder {
  justify-content: center;
  border-style: dashed;
  border-color: transparent;
  background: none;
  color: var(--kern-ink-400);
  font-size: 12px;
  cursor: default;
}
.label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.key {
  font-family: var(--kern-font-mono);
  font-size: 11px;
  color: var(--kern-ink-400);
}
.req {
  color: var(--kern-warning);
}
</style>
