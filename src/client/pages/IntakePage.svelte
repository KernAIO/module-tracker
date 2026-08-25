<script lang="ts">
import { Button, Checkbox, EmptyState, Icon, Input, Select, Spinner, Textarea } from '@kernhq/ui'
import { createMutation, createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { IntakeForm } from '../index.js'

/**
 * The form a stranger fills in.
 *
 * Public: no session, no workspace, no navigation — whoever opens this is not a member and may
 * never become one. So it shows one thing and asks for as little as it can, and every question
 * comes from the project's own layout rather than from a list kept in step by hand.
 *
 * The honeypot is a field real people never see, so anything in it came from a script. It is not a
 * CAPTCHA and does not pretend to be: the server rate-limits as well.
 */
interface Props {
  token: string
}
let { token }: Props = $props()

const api = getTrackerApi()

let answers = $state<Record<string, unknown>>({})
let website = $state('')

const formQuery = createQuery(() => ({
  queryKey: ['tracker', 'intake', token],
  queryFn: () => api.intake.form({ token }),
  retry: false,
}))
const form = $derived((formQuery.data ?? null) as IntakeForm | null)

const value = (key: string) => answers[key]
const set = (key: string, next: unknown) => {
  answers = { ...answers, [key]: next }
}

/** A question is answered when it holds something; a checkbox counts either way. */
const answered = (key: string, type: string) => {
  const v = answers[key]
  if (type === 'checkbox') return true
  return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
}

const missing = $derived((form?.fields ?? []).filter((f) => f.required && !answered(f.key, f.type)))
const canSubmit = $derived(Boolean(form) && missing.length === 0)

const submit = createMutation(() => ({
  mutationFn: () => {
    const custom: Record<string, unknown> = {}
    for (const field of form?.fields ?? [])
      if (field.key.startsWith('cf.') && answered(field.key, field.type))
        custom[field.key] = answers[field.key]
    return api.intake.submit({
      token,
      title: String(answers.title ?? ''),
      description: answers.description ? String(answers.description) : undefined,
      email: answers.email ? String(answers.email) : undefined,
      name: answers.name ? String(answers.name) : undefined,
      ...(Object.keys(custom).length ? { fields: custom } : {}),
      // empty for a person, filled by a script
      website,
    } as never)
  },
}))
</script>

<svelte:head>
  <title>{form ? form.title : t('intake_title')}</title>
  <!-- Nothing here should be indexed: it is a form for one project, not a page. -->
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="intake">
  {#if formQuery.isPending}
    <div class="state"><Spinner /></div>
  {:else if formQuery.isError || !form}
    <!-- A wrong or withdrawn link says so plainly; there is nothing to sign in to. -->
    <EmptyState icon="triangle-alert" title={t('intake_unavailable')} description={t('intake_unavailable_hint')} />
  {:else if submit.isSuccess}
    <div class="done" data-testid="intake-done">
      <Icon name="circle-check" size={28} strokeWidth={1.6} />
      <h1>{t('intake_thanks')}</h1>
      <p>{t('intake_reference', { key: submit.data.issueKey })}</p>
    </div>
  {:else}
    <header>
      <h1>{form.title}</h1>
      {#if form.description}<p class="lede">{form.description}</p>{/if}
    </header>

    <form
      onsubmit={(e) => {
        e.preventDefault()
        if (canSubmit) submit.mutate()
      }}
    >
      {#each form.fields as field (field.key)}
        <label class="field">
          <span class="q">
            {field.label}
            {#if field.required}<span class="req" aria-hidden="true">*</span>{/if}
          </span>
          {#if field.description}<span class="hint">{field.description}</span>{/if}

          {#if field.type === 'textarea'}
            <Textarea
              rows={4}
              value={String(value(field.key) ?? '')}
              required={field.required}
              oninput={(e: Event) => set(field.key, (e.currentTarget as HTMLTextAreaElement).value)}
            />
          {:else if field.type === 'select'}
            <Select
              value={String(value(field.key) ?? '')}
              options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
              onValueChange={(v: string) => set(field.key, v)}
            />
          {:else if field.type === 'multiselect'}
            <span class="choices">
              {#each field.options ?? [] as option (option.value)}
                {@const chosen = Array.isArray(value(field.key))
                  ? (value(field.key) as string[])
                  : []}
                <label class="choice">
                  <Checkbox
                    checked={chosen.includes(option.value)}
                    ariaLabel={option.label}
                    onCheckedChange={(on: boolean) =>
                      set(
                        field.key,
                        on
                          ? [...chosen, option.value]
                          : chosen.filter((v) => v !== option.value),
                      )}
                  />
                  {option.label}
                </label>
              {/each}
            </span>
          {:else if field.type === 'checkbox'}
            <span class="choice">
              <Checkbox
                checked={value(field.key) === true}
                ariaLabel={field.label}
                onCheckedChange={(on: boolean) => set(field.key, on)}
              />
            </span>
          {:else}
            <Input
              type={field.type === 'email'
                ? 'email'
                : field.type === 'number'
                  ? 'number'
                  : field.type === 'date'
                    ? 'date'
                    : field.type === 'url'
                      ? 'url'
                      : 'text'}
              value={String(value(field.key) ?? '')}
              required={field.required}
              data-testid="intake-{field.key}"
              oninput={(e: Event) => {
                const raw = (e.currentTarget as HTMLInputElement).value
                set(field.key, field.type === 'number' ? (raw === '' ? null : Number(raw)) : raw)
              }}
            />
          {/if}
        </label>
      {/each}

      <!-- The honeypot. Hidden from people, off the tab order, and never autofilled. -->
      <input
        class="hp"
        type="text"
        tabindex="-1"
        autocomplete="off"
        aria-hidden="true"
        bind:value={website}
      />

      {#if submit.isError}
        <p class="failed" role="alert">{t('intake_failed')}</p>
      {/if}

      <Button disabled={!canSubmit} loading={submit.isPending} onclick={() => canSubmit && submit.mutate()} data-testid="intake-submit">
        {t('intake_send')}
      </Button>
      <p class="note">{t('intake_privacy')}</p>
    </form>
  {/if}
</main>

<style>
.intake {
  max-width: 560px;
  margin: 0 auto;
  padding: 48px 20px 64px;
}
header h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.lede {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--kern-ink-550);
}
form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 24px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.q {
  font-size: 13px;
  font-weight: 500;
}
.req {
  color: var(--kern-danger);
  margin-inline-start: 2px;
}
.hint {
  font-size: 12px;
  color: var(--kern-ink-400);
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.hp {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.failed {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}
.note {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-400);
}
.state {
  display: grid;
  place-items: center;
  padding: 64px;
}
.done {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 64px 0;
  text-align: center;
  color: var(--kern-success, var(--kern-ink-900));
}
.done h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.done p {
  margin: 0;
  font-size: 14px;
  color: var(--kern-ink-550);
}
</style>
