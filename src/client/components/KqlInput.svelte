<script lang="ts">
import { Icon } from '@kernhq/ui'
import { t } from '../i18n.js'
import type { KqlField, KqlSuggestion } from '../index.js'
import { parseKql } from '../index.js'

/**
 * The KQL box in the toolbar.
 *
 * It validates as you type with the same reader the server uses, so a mistake is reported next to
 * the caret instead of after a round trip, and it offers the next token: a field, then an operator,
 * then the values that field actually has. Enter applies the query; a query that does not parse is
 * never applied, so the list cannot silently show the wrong thing.
 */
interface Props {
  /** the applied query; only updated on submit or clear */
  value: string
  fields: KqlField[]
  onapply: (kql: string) => void
}
let { value, fields, onapply }: Props = $props()

let draft = $state('')
let cursor = $state(0)
let focused = $state(false)
let highlighted = $state(0)
let input = $state<HTMLInputElement | null>(null)
let box = $state<HTMLDivElement | null>(null)
/**
 * The toolbar clips its own overflow, so the error and the suggestions are positioned against the
 * viewport and measured from the field rather than being laid out inside it.
 */
let anchor = $state({ top: 0, left: 0, width: 0 })
function measure() {
  const r = box?.getBoundingClientRect()
  if (r) anchor = { top: r.bottom + 6, left: r.left, width: r.width }
}

// adopt the applied query when it changes from elsewhere (a preset tab, a cleared filter)
$effect(() => {
  draft = value
})

const parsed = $derived(parseKql(draft, { fields, cursor }))
const suggestions = $derived(focused ? parsed.suggestions.slice(0, 8) : [])
const problem = $derived(draft.trim() && !parsed.ok ? (parsed.errors[0] ?? null) : null)
/**
 * A half-typed query is not a mistake. While there is something useful to offer, the box guides;
 * only when nothing fits does it say what is wrong. Enter refuses either way until it parses.
 */
const error = $derived(problem && suggestions.length === 0 ? problem : null)

$effect(() => {
  if (highlighted > suggestions.length - 1) highlighted = 0
})

function accept(suggestion: KqlSuggestion) {
  // replace the partial token under the caret rather than appending to it
  const before = draft.slice(0, cursor)
  const tokenStart = before.search(/[\w.]+$/)
  const head = tokenStart >= 0 ? before.slice(0, tokenStart) : before
  draft = head + suggestion.insertText + draft.slice(cursor)
  const next = (head + suggestion.insertText).length
  queueMicrotask(() => {
    input?.setSelectionRange(next, next)
    input?.focus()
    cursor = next
  })
}

function onkeydown(event: KeyboardEvent) {
  if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    highlighted = (highlighted + delta + suggestions.length) % suggestions.length
    return
  }
  if (event.key === 'Tab' && suggestions.length) {
    event.preventDefault()
    const picked = suggestions[highlighted]
    if (picked) accept(picked)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (suggestions.length && highlighted > 0) {
      const picked = suggestions[highlighted]
      if (picked) accept(picked)
      return
    }
    if (parsed.ok) {
      onapply(draft.trim())
      input?.blur()
    }
    return
  }
  if (event.key === 'Escape') {
    if (focused) {
      event.stopPropagation()
      draft = value
      input?.blur()
    }
  }
}

function track(event: Event) {
  cursor = (event.currentTarget as HTMLInputElement).selectionStart ?? draft.length
  measure()
}
</script>

<svelte:window onresize={() => focused && measure()} />

<div class="kkql" class:invalid={Boolean(error)} bind:this={box}>
  <Icon name="search" size={14} strokeWidth={1.7} />
  <input
    bind:this={input}
    bind:value={draft}
    type="text"
    spellcheck="false"
    autocomplete="off"
    data-testid="kql-input"
    placeholder={t('kql_placeholder')}
    aria-label={t('kql_label')}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={error ? 'kql-error' : undefined}
    onfocus={() => {
      focused = true
      measure()
    }}
    onblur={() => setTimeout(() => (focused = false), 120)}
    oninput={track}
    onclick={track}
    onkeyup={track}
    {onkeydown}
  />
  {#if draft}
    <button
      type="button"
      class="clear"
      aria-label={t('kql_clear')}
      onclick={() => {
        draft = ''
        onapply('')
      }}
    >
      <Icon name="x" size={12} strokeWidth={2} />
    </button>
  {/if}

  {#if focused && suggestions.length}
    <ul class="sug" style:top="{anchor.top}px" style:left="{anchor.left}px" style:width="{anchor.width}px">
      {#each suggestions as suggestion, i (suggestion.kind + suggestion.label)}
        <li>
          <button
            type="button"
            class:on={i === highlighted}
            onmousedown={(e) => {
              e.preventDefault()
              accept(suggestion)
            }}
          >
            <span class="kind">{suggestion.kind}</span>
            <span class="lbl">{suggestion.label}</span>
            {#if suggestion.detail}<span class="det">{suggestion.detail}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else if error}
    <p
      class="err"
      id="kql-error"
      role="status"
      style:top="{anchor.top}px"
      style:left="{anchor.left}px"
      style:width="{anchor.width}px"
    >
      {error.message}
    </p>
  {/if}
</div>

<style>
  .kkql {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    min-width: 180px;
    flex: 1 1 240px;
    max-width: 460px;
    padding: 0 10px;
    border: 1px solid var(--kern-border);
    border-radius: var(--kern-r-lg);
    background: var(--kern-surface-input);
    color: var(--kern-ink-250);
  }
  .kkql:focus-within {
    border-color: var(--kern-accent);
    box-shadow: 0 0 0 3px var(--kern-ring);
  }
  .kkql.invalid {
    border-color: var(--kern-danger);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    font-family: var(--kern-font-mono);
    font-size: 12.5px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-800);
  }
  input:focus-visible {
    box-shadow: none;
  }
  .clear {
    display: grid;
    place-items: center;
    color: var(--kern-ink-350);
  }
  .clear:hover {
    color: var(--kern-ink-900);
  }
  .err,
  .sug {
    position: fixed;
    z-index: 30;
    margin: 0;
    background: var(--kern-surface-raised);
    border-radius: var(--kern-r-2xl);
    box-shadow: var(--kern-shadow-popover);
    animation: kfade 0.12s ease-out;
  }
  .err {
    padding: 8px 12px;
    font-size: 12.5px;
    color: var(--kern-danger);
  }
  .sug {
    list-style: none;
    padding: 4px;
    /* the field is narrow; the list is not bound by it */
    min-width: 340px;
    max-width: min(520px, 90vw);
    max-height: 260px;
    overflow-y: auto;
  }
  .sug button {
    display: flex;
    align-items: baseline;
    gap: 9px;
    width: 100%;
    padding: 6px 9px;
    border-radius: var(--kern-r-md);
    text-align: start;
  }
  .sug button:hover,
  .sug button.on {
    background: var(--kern-surface-popover-hover);
  }
  .kind {
    font-family: var(--kern-font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--kern-ink-250);
    width: 58px;
    flex: none;
  }
  .lbl {
    font-family: var(--kern-font-mono);
    font-size: 12.5px;
    color: var(--kern-ink-800);
    white-space: nowrap;
  }
  .det {
    font-size: 12px;
    color: var(--kern-ink-350);
    margin-inline-start: auto;
    padding-inline-start: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 900px) {
    .kkql {
      display: none;
    }
  }
</style>
