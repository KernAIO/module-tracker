<script lang="ts">
import { Button, Checkbox, Dialog, Icon, Input, Select, Textarea } from '@kernhq/ui'
import { t } from '../i18n.js'
import type { WorkItemType } from '../index.js'

/**
 * Creating or editing one work item type.
 *
 * A type's `key` is fixed after creation for the same reason a field's is: it is what imports, the
 * API and saved queries name it by, so changing it would orphan every one of them.
 *
 * `level` is the one setting whose meaning is not obvious from its name, so the dialog spells out
 * what each level does rather than showing the numbers the contract uses. It decides what may
 * parent what — an epic can hold a story, a story cannot hold an epic.
 */
interface Props {
  open: boolean
  /** null when creating */
  type: WorkItemType | null
  busy?: boolean
  onclose: () => void
  onsave: (input: Record<string, unknown>) => void
}
let { open, type, busy = false, onclose, onsave }: Props = $props()

/** The registry holds 106 icons; these are the ones that mean something on a work item type. */
const ICONS = [
  'square-check-big',
  'bug',
  'bookmark',
  'zap',
  'flag',
  'target',
  'file-text',
  'wrench',
  'shield',
  'palette',
  'circle-alert',
  'briefcase',
]

const LEVELS: { value: string; label: () => string; description: () => string }[] = [
  { value: '2', label: () => t('level_2'), description: () => t('level_2_hint') },
  { value: '1', label: () => t('level_1'), description: () => t('level_1_hint') },
  { value: '0', label: () => t('level_0'), description: () => t('level_0_hint') },
  { value: '-1', label: () => t('level_sub'), description: () => t('level_sub_hint') },
]

let name = $state('')
let key = $state('')
let description = $state('')
let icon = $state('square-check-big')
let level = $state('0')
let isDefault = $state(false)
/** Touched once, the key stops following the name — otherwise a rename would rewrite it. */
let keyEdited = $state(false)

const editing = $derived(Boolean(type))

$effect(() => {
  if (!open) return
  name = type?.name ?? ''
  key = type?.key ?? ''
  description = type?.description ?? ''
  icon = type?.icon ?? 'square-check-big'
  level = String(type?.level ?? 0)
  isDefault = type?.isDefault ?? false
  keyEdited = Boolean(type)
})

/** `Customer request` → `customer_request`: the key is a machine name, not a sentence. */
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)

$effect(() => {
  if (!keyEdited) key = slugify(name)
})

const keyValid = $derived(/^[a-z][a-z0-9_]*$/.test(key))
const valid = $derived(Boolean(name.trim()) && keyValid)

function save() {
  if (!valid || busy) return
  onsave({
    name: name.trim(),
    description: description.trim() || null,
    icon,
    level: Number(level),
    isDefault,
    // the key is what every import, query and API caller names this type by
    ...(editing ? {} : { key }),
  })
}
</script>

<Dialog
  {open}
  title={editing ? t('type_edit') : t('type_new')}
  size="md"
  onOpenChange={(next: boolean) => {
    if (!next) onclose()
  }}
>
  <div class="grid gap-3">
    <label class="grid gap-1">
      <span class="lbl">{t('type_name')}</span>
      <Input bind:value={name} placeholder="Incident" data-testid="type-name" />
    </label>

    <label class="grid gap-1">
      <span class="lbl">{t('type_key')}</span>
      <Input
        bind:value={key}
        disabled={editing}
        oninput={() => (keyEdited = true)}
        placeholder="incident"
        data-testid="type-key"
      />
      <span class="hint" class:bad={!keyValid && key.length > 0}>
        {editing ? t('type_key_fixed') : t('type_key_hint')}
      </span>
    </label>

    <div class="grid gap-1">
      <span class="lbl">{t('type_icon')}</span>
      <!-- Twelve buttons rather than a menu of 106 names: an icon is chosen by looking at it. -->
      <div class="icons" data-testid="type-icons">
        {#each ICONS as candidate (candidate)}
          <button
            type="button"
            class="ico"
            class:on={icon === candidate}
            aria-pressed={icon === candidate}
            aria-label={candidate}
            onclick={() => (icon = candidate)}
          >
            <Icon name={candidate} size={16} strokeWidth={1.8} />
          </button>
        {/each}
      </div>
    </div>

    <label class="grid gap-1">
      <span class="lbl">{t('type_level')}</span>
      <Select
        value={level}
        options={LEVELS.map((l) => ({ value: l.value, label: l.label(), description: l.description() }))}
        onValueChange={(v: string) => (level = v)}
      />
      <span class="hint">{t('type_level_hint')}</span>
    </label>

    <label class="grid gap-1">
      <span class="lbl">{t('type_description')}</span>
      <Textarea bind:value={description} rows={2} />
    </label>

    <Checkbox
      checked={isDefault}
      label={t('type_make_default')}
      onCheckedChange={(on: boolean) => (isDefault = on)}
    />
    <span class="hint">{t('type_default_hint')}</span>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={onclose}>{t('common.cancel')}</Button>
    <Button size="sm" disabled={!valid} loading={busy} onclick={save} data-testid="type-save">
      {t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<style>
.lbl {
  font-size: 12px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.hint {
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
.hint.bad {
  color: var(--kern-danger);
}
.icons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ico {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-600);
  cursor: pointer;
}
.ico:hover {
  background: var(--kern-surface-hover);
}
.ico.on {
  border-color: var(--kern-accent);
  color: var(--kern-accent);
}
</style>
