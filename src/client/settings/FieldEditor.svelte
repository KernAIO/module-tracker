<script lang="ts">
import { Button, Checkbox, Dialog, IconButton, Input, Select, Textarea } from '@kernhq/ui'
import { t } from '../i18n.js'
import type { FieldDef, FieldOption, FieldType } from '../index.js'

/**
 * Creating or editing one custom field.
 *
 * A field's `key` and `type` are fixed after creation: the key is where values live in
 * `issues.custom` and the type is what validates them, so changing either would reinterpret every
 * value already stored. The dialog says so rather than silently disabling the inputs.
 */
interface Props {
  open: boolean
  /** null when creating */
  field: FieldDef | null
  busy?: boolean
  onclose: () => void
  onsave: (input: Record<string, unknown>) => void
}
let { open, field, busy = false, onclose, onsave }: Props = $props()

const TYPES: FieldType[] = [
  'text',
  'textarea',
  'number',
  'select',
  'multiselect',
  'date',
  'datetime',
  'user',
  'multiuser',
  'label',
  'url',
  'checkbox',
  'relation',
  'formula',
]

const TYPE_LABELS: Record<FieldType, () => string> = {
  text: () => t('ft_text'),
  textarea: () => t('ft_textarea'),
  number: () => t('ft_number'),
  select: () => t('ft_select'),
  multiselect: () => t('ft_multiselect'),
  date: () => t('ft_date'),
  datetime: () => t('ft_datetime'),
  user: () => t('ft_user'),
  multiuser: () => t('ft_multiuser'),
  label: () => t('ft_label'),
  url: () => t('ft_url'),
  checkbox: () => t('ft_checkbox'),
  relation: () => t('ft_relation'),
  formula: () => t('ft_formula'),
}

const HAS_OPTIONS: ReadonlySet<FieldType> = new Set(['select', 'multiselect', 'label'])

let name = $state('')
let key = $state('')
let description = $state('')
let type = $state<FieldType>('text')
let required = $state(false)
let searchable = $state(false)
let showInCards = $state(false)
let options = $state<FieldOption[]>([])
let minText = $state('')
let maxText = $state('')
let maxLengthText = $state('')
let pattern = $state('')
/** Touched once, the key stops following the name — otherwise a rename would rewrite it. */
let keyEdited = $state(false)

const editing = $derived(Boolean(field))

/** Reset every time the dialog opens, so a cancelled edit does not leak into the next one. */
$effect(() => {
  if (!open) return
  name = field?.name ?? ''
  key = field?.key ?? ''
  description = field?.description ?? ''
  type = field?.type ?? 'text'
  required = field?.required ?? false
  searchable = field?.searchable ?? false
  showInCards = field?.showInCards ?? false
  options = field ? field.options.map((o) => ({ ...o })) : []
  minText = field?.config.min?.toString() ?? ''
  maxText = field?.config.max?.toString() ?? ''
  maxLengthText = field?.config.maxLength?.toString() ?? ''
  pattern = field?.config.pattern ?? ''
  keyEdited = Boolean(field)
})

/** `Customer email` → `customer_email`: the key is a machine name, not a sentence. */
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
/**
 * A bad pattern is compiled here rather than at value-check time: `config.pattern` is
 * administrator-supplied, and one unparseable save would otherwise poison every write to a project.
 */
const patternValid = $derived.by(() => {
  if (!pattern) return true
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
})
const optionsValid = $derived(
  !HAS_OPTIONS.has(type) || (options.length > 0 && options.every((o) => o.label.trim())),
)
const valid = $derived(Boolean(name.trim()) && keyValid && patternValid && optionsValid)

function addOption() {
  options = [
    ...options,
    {
      id: `opt_${Math.random().toString(36).slice(2, 8)}`,
      label: '',
      color: null,
      order: options.length,
      archived: false,
    },
  ]
}

function save() {
  if (!valid || busy) return
  const config: Record<string, unknown> = {}
  if (type === 'number' && minText.trim()) config.min = Number(minText)
  if (type === 'number' && maxText.trim()) config.max = Number(maxText)
  if ((type === 'text' || type === 'textarea') && maxLengthText.trim())
    config.maxLength = Number(maxLengthText)
  if ((type === 'text' || type === 'textarea') && pattern.trim()) config.pattern = pattern.trim()

  onsave({
    name: name.trim(),
    description: description.trim() || null,
    required,
    searchable,
    showInCards,
    config,
    ...(HAS_OPTIONS.has(type) ? { options: options.map((o, i) => ({ ...o, order: i })) } : {}),
    // key and type are fixed once values exist under them
    ...(editing ? {} : { key, type }),
  })
}
</script>

<Dialog
  {open}
  title={editing ? t('field_edit') : t('field_new')}
  size="md"
  onOpenChange={(next: boolean) => {
    if (!next) onclose()
  }}
>
  <div class="grid gap-3">
    <label class="grid gap-1">
      <span class="lbl">{t('field_name')}</span>
      <Input bind:value={name} placeholder="Severity" data-testid="field-name" />
    </label>

    <label class="grid gap-1">
      <span class="lbl">{t('field_key')}</span>
      <Input
        bind:value={key}
        disabled={editing}
        oninput={() => (keyEdited = true)}
        placeholder="severity"
        data-testid="field-key"
      />
      <span class="hint" class:bad={!keyValid && key.length > 0}>
        {editing ? t('field_key_fixed') : t('field_key_hint')}
      </span>
    </label>

    <label class="grid gap-1">
      <span class="lbl">{t('field_type')}</span>
      <Select
        value={type}
        disabled={editing}
        options={TYPES.map((kind) => ({ value: kind, label: TYPE_LABELS[kind]() }))}
        onValueChange={(v: string) => (type = v as FieldType)}
      />
      {#if editing}
        <span class="hint">{t('field_type_fixed')}</span>
      {/if}
    </label>

    <label class="grid gap-1">
      <span class="lbl">{t('field_description')}</span>
      <Textarea bind:value={description} rows={2} />
    </label>

    {#if HAS_OPTIONS.has(type)}
      <div class="grid gap-1">
        <span class="lbl">{t('field_options')}</span>
        {#each options as option, i (option.id)}
          <div class="orow">
            <Input
              value={option.label}
              placeholder={t('field_option_label')}
              oninput={(e: Event) => {
                const value = (e.currentTarget as HTMLInputElement).value
                options = options.map((o, j) => (i === j ? { ...o, label: value } : o))
              }}
            />
            <IconButton
              icon="x"
              size={26}
              label={t('field_option_remove')}
              onclick={() => (options = options.filter((_, j) => j !== i))}
            />
          </div>
        {/each}
        <div>
          <Button size="sm" variant="ghost" onclick={addOption}>{t('field_option_add')}</Button>
        </div>
        {#if !optionsValid}
          <span class="hint bad">{t('field_options_required')}</span>
        {/if}
      </div>
    {/if}

    {#if type === 'number'}
      <div class="two">
        <label class="grid gap-1">
          <span class="lbl">{t('field_min')}</span>
          <Input bind:value={minText} type="number" />
        </label>
        <label class="grid gap-1">
          <span class="lbl">{t('field_max')}</span>
          <Input bind:value={maxText} type="number" />
        </label>
      </div>
    {/if}

    {#if type === 'text' || type === 'textarea'}
      <div class="two">
        <label class="grid gap-1">
          <span class="lbl">{t('field_maxlength')}</span>
          <Input bind:value={maxLengthText} type="number" />
        </label>
        <label class="grid gap-1">
          <span class="lbl">{t('field_pattern')}</span>
          <Input bind:value={pattern} placeholder="^[A-Z]{2}-\d+$" />
          {#if !patternValid}
            <span class="hint bad">{t('field_pattern_invalid')}</span>
          {/if}
        </label>
      </div>
    {/if}

    <label class="check">
      <Checkbox checked={required} onCheckedChange={(v: boolean) => (required = v)} />
      <span>
        {t('field_required')}
        <span class="hint">{t('field_required_hint')}</span>
      </span>
    </label>
    <label class="check">
      <Checkbox checked={searchable} onCheckedChange={(v: boolean) => (searchable = v)} />
      <span>
        {t('field_searchable')}
        <span class="hint">{t('field_searchable_hint')}</span>
      </span>
    </label>
    <label class="check">
      <Checkbox checked={showInCards} onCheckedChange={(v: boolean) => (showInCards = v)} />
      <span>{t('field_show_in_cards')}</span>
    </label>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={onclose}>{t('common.cancel')}</Button>
    <Button size="sm" disabled={!valid} loading={busy} onclick={save} data-testid="field-save">
      {editing ? t('common.save') : t('common.add')}
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
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.orow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
</style>
