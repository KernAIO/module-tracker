<script lang="ts">
import { Button, Icon, IconButton, rankCandidates, Spinner, toast, uploadFile } from '@kernhq/ui'
import { type MentionCandidate, RichTextEditor } from '@kernhq/ui/editor'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import type { RichDoc } from '../index.js'
import { isEmptyDoc } from '../richtext.js'

/**
 * Writing a comment: text, `@` mentions, and files.
 *
 * The same `@` machinery chat uses (`$lib/mentions`), so a mention here is a real mention node the
 * server turns into a notification, not the characters `@Ada` sitting in a sentence.
 *
 * Files upload as you pick them and are attached to the comment once it exists — a comment id has
 * to exist before an attachment can point at it, so the parent posts the comment and then hands
 * the ids over.
 */
interface Props {
  initial?: RichDoc | null
  placeholder?: string
  submitLabel?: string
  /** editing an existing comment cannot add files: they attach at creation */
  allowFiles?: boolean
  busy?: boolean
  /** the workspace the files belong to */
  workspaceId: string
  oncancel?: () => void
  onsubmit: (body: RichDoc, fileIds: string[], internal: boolean) => void
}
let {
  initial = null,
  placeholder = t('comment_placeholder'),
  submitLabel = t('comment_send'),
  allowFiles = true,
  busy = false,
  workspaceId,
  oncancel,
  onsubmit,
}: Props = $props()

const cat = getTrackerCatalogue()

// The starting draft only: later prop changes must not overwrite what is being typed.
let body = $state<RichDoc | null>(initial ?? null)
let internal = $state(false)
let fileInput = $state<HTMLInputElement | null>(null)

let uploads = $state<Array<{ id: string; name: string; ratio: number | null; fileId: string | null }>>([])

/*
 * Mentions are nodes in the document now, not a list kept beside a string. The editor inserts a
 * real `mention` node when someone is picked, so there is nothing left to reconcile on save and
 * no way for a hand-typed "@Ada" to be mistaken for one.
 */
const people = $derived(cat.people.map((p) => ({ id: p.id, name: p.name, avatarUrl: p.avatarUrl ?? null })))
/* `rankCandidates` is the ranking chat uses, and it wants a lowercased query and a `name`; the
   editor speaks `label`. Bridge here rather than forking either. */
const mentionSource = (query: string): MentionCandidate[] =>
  rankCandidates(people, query.toLowerCase()).map((p) => ({
    id: p.id,
    label: p.name,
    avatarUrl: p.avatarUrl ?? null,
  }))

const ready = $derived(uploads.every((u) => u.fileId !== null))
const empty = $derived(isEmptyDoc(body))

async function addFiles(list: FileList | null) {
  if (!list?.length) return
  for (const file of Array.from(list)) {
    const id = crypto.randomUUID()
    uploads = [...uploads, { id, name: file.name, ratio: 0, fileId: null }]
    try {
      const uploaded = await uploadFile({
        workspaceId,
        file,
        name: file.name,
        mimeType: file.type || undefined,
        onProgress: ({ ratio }) => {
          uploads = uploads.map((u) => (u.id === id ? { ...u, ratio } : u))
        },
      })
      uploads = uploads.map((u) => (u.id === id ? { ...u, ratio: 1, fileId: uploaded.id } : u))
    } catch (err) {
      // Drop the row rather than leave a file that looks attached and is not.
      uploads = uploads.filter((u) => u.id !== id)
      toast.error(err instanceof Error ? err.message : t('attachment_failed'))
    }
  }
}

function submit() {
  if (empty || busy || !ready) return
  onsubmit(
    // A state proxy cannot survive `structuredClone` on the way to the API — snapshot it first.
    $state.snapshot(body) as RichDoc,
    uploads.map((u) => u.fileId).filter((id): id is string => Boolean(id)),
    internal,
  )
  body = null
  uploads = []
  internal = false
}
</script>

<div class="composer">
  <RichTextEditor
    bind:value={body}
    minRows={2}
    {placeholder}
    label={placeholder}
    {mentionSource}
    data-testid="comment-input"
    onsubmit={submit}
    onescape={oncancel}
  />

  {#if uploads.length}
    <ul class="uploads">
      {#each uploads as file (file.id)}
        <li>
          {#if file.fileId}
            <Icon name="paperclip" size={12} strokeWidth={1.8} />
          {:else}
            <Spinner size={12} />
          {/if}
          <span class="uname">{file.name}</span>
          <IconButton
            icon="x"
            size={22}
            label={t('attachment_remove')}
            onclick={() => (uploads = uploads.filter((u) => u.id !== file.id))}
          />
        </li>
      {/each}
    </ul>
  {/if}

  <div class="actions">
    {#if allowFiles}
      <input
        bind:this={fileInput}
        type="file"
        multiple
        hidden
        onchange={(e) => {
          void addFiles(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />
      <IconButton
        icon="paperclip"
        size={26}
        label={t('attach_file')}
        onclick={() => fileInput?.click()}
      />
      <label class="internal">
        <input type="checkbox" bind:checked={internal} />
        <span title={t('comment_internal_hint')}>{t('comment_internal')}</span>
      </label>
    {/if}
    <span class="hint">{t('comment_hint')}</span>
    {#if oncancel}
      <Button size="sm" variant="ghost" onclick={oncancel}>{t('common.cancel')}</Button>
    {/if}
    <Button size="sm" disabled={empty || busy || !ready} onclick={submit}>{submitLabel}</Button>
  </div>
</div>

<style>
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.uploads {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.uploads li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface-active);
  font-size: 12px;
}
.uname {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.internal {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--kern-ink-350);
  cursor: pointer;
}
.hint {
  flex: 1;
  font-size: 11px;
  color: var(--kern-ink-350);
}
</style>
