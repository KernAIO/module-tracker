<script lang="ts">
import {
  Avatar,
  Button,
  DropdownMenu,
  formatBytes,
  Icon,
  IconButton,
  type MenuItem,
  relativeTime,
  Sheet,
  Spinner,
  session,
  toast,
  uploadFile,
} from '@kernhq/ui'
import { RichTextEditor } from '@kernhq/ui/editor'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import type {
  AvailableTransition,
  Issue,
  Comment as IssueComment,
  Priority,
  ResolvedField,
  RichDoc,
} from '../index.js'
import { PRIORITY_GROUP_ORDER } from '../index.js'
import { estimateLabel, estimateUnitOf, priorityLabel } from '../labels.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { renderDoc } from '../richtext.js'
import CommentComposer from './CommentComposer.svelte'
import CommentThread from './CommentThread.svelte'
import CustomField from './CustomField.svelte'
import DueDate from './DueDate.svelte'
import IssueApprovals from './IssueApprovals.svelte'
import IssueConnections from './IssueConnections.svelte'
import IssueTime from './IssueTime.svelte'
import PriorityGlyph from './PriorityGlyph.svelte'
import StatusIcon from './StatusIcon.svelte'

/**
 * The issue detail panel (DESIGN.md 3.13).
 *
 * A 440px panel over the content column rather than a page of its own: you keep your place in the
 * list, and closing it puts you back exactly where you were. Every property is editable in place,
 * and each edit is its own small mutation, so a failed request only rolls back the field it touched.
 */
interface Props {
  workspaceId: string
  /** the issue key from the URL, so a panel can be linked to and reopened after a reload */
  issueKey: string | null
  onclose: () => void
  /** follow a connection to another issue — the page owns the URL, not this panel */
  onopenissue: (key: string) => void
}
let { workspaceId, issueKey, onclose, onopenissue }: Props = $props()

/** The built-in properties, in the order the panel showed them before layouts existed. */
const FALLBACK_SIDEBAR: ResolvedField[] = [
  'status',
  'assignees',
  'priority',
  'dueDate',
  'labels',
  'cycle',
  'estimate',
  'project',
].map((fieldId, order) => ({
  fieldId,
  kind: 'system' as const,
  label: fieldId,
  section: 'sidebar' as const,
  order,
  required: false,
  pinned: fieldId === 'status',
  showInCards: false,
  field: null,
}))

const api = getTrackerApi()
const cat = getTrackerCatalogue()

let issueFileInput = $state<HTMLInputElement | null>(null)

/** Uploads first, then attaches: an attachment points at a file that already exists. */
async function uploadIssueFiles(list: FileList | null) {
  if (!list?.length) return
  const ids: string[] = []
  for (const file of Array.from(list)) {
    try {
      const uploaded = await uploadFile({
        workspaceId,
        file,
        name: file.name,
        mimeType: file.type || undefined,
        attachedTo: { module: 'tracker', type: 'issue', id: issue?.id as string },
      })
      ids.push(uploaded.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('attachment_failed'))
    }
  }
  if (ids.length) addIssueFiles.mutate(ids)
}
const queryClient = useQueryClient()

let editingDescription = $state(false)
/** Named on screen before it happens, never behind `window.confirm`. */
let confirmingDelete = $state(false)
let descriptionDraft = $state<RichDoc | null>(null)

const issueQuery = createQuery(() => ({
  queryKey: trackerKeys.issue(workspaceId, issueKey ?? ''),
  queryFn: () => api.issues.getByKey({ workspaceId, key: issueKey as string }),
  enabled: Boolean(issueKey),
}))
const issue = $derived(issueQuery.data ?? null)
const issueId = $derived(issue?.id ?? null)

/**
 * What this issue's type says to show, in what order. The panel used to render eight fixed
 * properties; it now renders whatever the type's layout resolves to, with the built-in controls
 * keyed by field id so nothing about them changed.
 */
const layoutQuery = createQuery(() => ({
  queryKey: trackerKeys.layout(workspaceId, issue?.typeId ?? '', issue?.projectId ?? null),
  queryFn: () =>
    api.types.layout({
      workspaceId,
      id: issue?.typeId as string,
      projectId: issue?.projectId ?? null,
    }),
  enabled: Boolean(issue?.typeId),
}))
/**
 * Until the layout arrives, show the built-in properties in their default order rather than an
 * empty panel — the fields are already in `issue`, so a spinner here would be a blank column over
 * data we have.
 */
const sidebarFields = $derived(layoutQuery.data?.sidebar ?? FALLBACK_SIDEBAR)
/**
 * Custom fields the type puts in the main column. `title` and `description` are system fields with
 * their own places, so only custom ones need rendering here — without this, moving a field to Main
 * in settings would make it disappear from the issue entirely.
 */
const mainFields = $derived((layoutQuery.data?.main ?? []).filter((f) => f.kind === 'custom' && f.field))

const commentsQuery = createQuery(() => ({
  queryKey: trackerKeys.comments(workspaceId, issueId ?? ''),
  queryFn: () => api.issues.comments.list({ workspaceId, issueId: issueId as string, limit: 50 }),
  enabled: Boolean(issueId),
}))

const historyQuery = createQuery(() => ({
  queryKey: trackerKeys.history(workspaceId, issueId ?? ''),
  queryFn: () => api.issues.history({ workspaceId, issueId: issueId as string, limit: 50 }),
  enabled: Boolean(issueId),
}))

const transitionsQuery = createQuery(() => ({
  queryKey: trackerKeys.transitions(workspaceId, issueId ?? ''),
  queryFn: () => api.issues.transitions.available({ workspaceId, issueId: issueId as string }),
  enabled: Boolean(issueId),
}))

const project = $derived(cat.project(issue?.projectId))
const status = $derived(cat.status(issue?.statusId))
const cycle = $derived(cat.cycle(issue?.cycleId))
const watching = $derived(Boolean(issue && session.user && issue.watcherIds.includes(session.user.id)))

// the server enforces these too; here they decide whether a control is offered at all
const canTriage = $derived(canTracker('triageManage'))
const canEdit = $derived(canTracker('edit'))
const canTransition = $derived(canTracker('transition'))
const canComment = $derived(canTracker('comment'))

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] })
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'transition'] })
}

const patch = createMutation(() => ({
  mutationFn: (input: Record<string, unknown>) =>
    api.issues.update({ workspaceId, issueId: issue?.id as string, patch: input as never }),
  onSuccess: invalidate,
  onError: (error: Error) => toast.error(error.message),
}))

const transition = createMutation(() => ({
  mutationFn: (transitionId: string) =>
    api.issues.transitions.apply({ workspaceId, issueId: issue?.id as string, transitionId }),
  onSuccess: (result) => {
    invalidate()
    void queryClient.invalidateQueries({ queryKey: trackerKeys.history(workspaceId, issue?.id ?? '') })
    // A transition that needs sign-off does not move the issue; it returns the approval it is
    // waiting on. Without refetching approvals — and saying so — the click looks like it did
    // nothing at all.
    if (result.approval) {
      void queryClient.invalidateQueries({
        queryKey: trackerKeys.approvals(workspaceId, issue?.id ?? ''),
      })
      toast.info(t('approval_requested_toast'))
    }
  },
  onError: (error: Error) => toast.error(error.message),
}))

const comment = createMutation(() => ({
  mutationFn: async (input: { body: RichDoc; fileIds: string[]; internal: boolean; parentId?: string }) => {
    const created = await api.issues.comments.create({
      workspaceId,
      issueId: issue?.id as string,
      body: input.body,
      internal: input.internal,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    })
    // The comment has to exist before a file can point at it, so the upload happens in the
    // composer and the attachment is claimed here.
    if (input.fileIds.length)
      await api.issues.attachments.add({
        workspaceId,
        issueId: issue?.id as string,
        fileIds: input.fileIds,
        commentId: created.id,
      })
    return created
  },
  onSuccess: () => {
    refreshComments()
    invalidate()
  },
  onError: (error: Error) => toast.error(error.message),
}))

const attachmentsQuery = createQuery(() => ({
  queryKey: trackerKeys.attachments(workspaceId, issueId ?? ''),
  queryFn: () => api.issues.attachments.list({ workspaceId, issueId: issueId as string }),
  enabled: Boolean(issueId),
}))
const attachments = $derived(attachmentsQuery.data ?? [])
/** Files that arrived with a comment, so each comment can show its own. */
const attachmentsByComment = $derived.by(() => {
  const byComment = new Map<string, typeof attachments>()
  for (const file of attachments) {
    if (!file.commentId) continue
    byComment.set(file.commentId, [...(byComment.get(file.commentId) ?? []), file])
  }
  return byComment
})
const issueAttachments = $derived(attachments.filter((f) => !f.commentId))

const refreshComments = () => {
  void queryClient.invalidateQueries({ queryKey: trackerKeys.comments(workspaceId, issue?.id ?? '') })
  void queryClient.invalidateQueries({
    queryKey: trackerKeys.attachments(workspaceId, issue?.id ?? ''),
  })
}

const editComment = createMutation(() => ({
  mutationFn: (input: { commentId: string; body: RichDoc }) =>
    api.issues.comments.update({ workspaceId, ...input }),
  onSuccess: refreshComments,
  onError: (error: Error) => toast.error(error.message),
}))

const deleteComment = createMutation(() => ({
  mutationFn: (commentId: string) => api.issues.comments.delete({ workspaceId, commentId }),
  onSuccess: refreshComments,
  onError: (error: Error) => toast.error(error.message),
}))

/**
 * Triage: what to do with something that arrived from outside.
 *
 * The three actions have existed on the server since intake did and nothing offered them, so an
 * issue raised by email or through the public form sat in triage with no way out but editing its
 * status by hand — which skips the workflow's initial status and the decline comment entirely.
 */
const triage = createMutation(() => ({
  mutationFn: (input: { action: 'accept' | 'decline' | 'snooze'; until?: string }) => {
    const issueId = issue?.id as string
    if (input.action === 'accept') return api.triage.accept({ workspaceId, issueId })
    if (input.action === 'decline') return api.triage.decline({ workspaceId, issueId })
    return api.triage.snooze({ workspaceId, issueId, until: input.until as string })
  },
  onSuccess: () => {
    invalidate()
    void queryClient.invalidateQueries({ queryKey: trackerKeys.history(workspaceId, issue?.id ?? '') })
  },
  onError: (error: Error) => toast.error(error.message),
}))

/** A week is the interval somebody means by "not now"; anything finer belongs on a date picker. */
const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString()

/**
 * What happens to an issue as a whole: move it, archive it, delete it.
 *
 * All three had a server and no control, so an issue raised in the wrong project stayed there and
 * a mistake could never be taken back. Archiving is the ordinary one — it leaves the issue and its
 * history intact and off every list — so it is the one offered first; deleting is behind a
 * confirmation that says what goes with it.
 */
const moveIssue = createMutation(() => ({
  mutationFn: (projectId: string) =>
    api.issues.move({ workspaceId, issueId: issue?.id as string, projectId }),
  onSuccess: (moved: Issue) => {
    invalidate()
    // The key changed with the project, so the panel is now pointed at a key that no longer
    // exists. Following it is the only thing that leaves the screen showing the same issue.
    toast.success(t('issue_moved', { key: moved.key }))
    onopenissue(moved.key)
  },
  onError: (error: Error) => toast.error(error.message),
}))

const archiveIssue = createMutation(() => ({
  mutationFn: (archived: boolean) =>
    api.issues.archive({ workspaceId, issueId: issue?.id as string, archived }),
  onSuccess: () => {
    invalidate()
    void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue', workspaceId] })
  },
  onError: (error: Error) => toast.error(error.message),
}))

const deleteIssue = createMutation(() => ({
  mutationFn: () => api.issues.delete({ workspaceId, issueId: issue?.id as string }),
  onSuccess: () => {
    confirmingDelete = false
    void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue', workspaceId] })
    toast.success(t('issue_deleted'))
    onclose()
  },
  onError: (error: Error) => toast.error(error.message),
}))

const issueMenu = $derived<MenuItem[]>([
  {
    id: 'move',
    label: t('issue_move'),
    icon: 'arrow-right',
    disabled: !canEdit,
    children: cat.projects
      .filter((p) => p.id !== issue?.projectId)
      .map((p) => ({
        id: p.id,
        label: `${p.key} · ${p.name}`,
        onSelect: () => moveIssue.mutate(p.id),
      })),
  },
  {
    id: 'archive',
    label: issue?.archivedAt ? t('issue_unarchive') : t('common.archive'),
    icon: 'archive',
    disabled: !canEdit,
    onSelect: () => archiveIssue.mutate(!issue?.archivedAt),
  },
  { type: 'separator' },
  {
    id: 'delete',
    label: t('common.delete'),
    icon: 'trash-2',
    danger: true,
    disabled: !canEdit,
    onSelect: () => (confirmingDelete = true),
  },
])

const removeAttachment = createMutation(() => ({
  mutationFn: (attachmentId: string) => api.issues.attachments.remove({ workspaceId, attachmentId }),
  onSuccess: refreshComments,
  onError: (error: Error) => toast.error(error.message),
}))

const addIssueFiles = createMutation(() => ({
  mutationFn: (fileIds: string[]) =>
    api.issues.attachments.add({ workspaceId, issueId: issue?.id as string, fileIds }),
  onSuccess: refreshComments,
  onError: (error: Error) => toast.error(error.message),
}))

const react = createMutation(() => ({
  mutationFn: (input: { commentId: string; emoji: string }) =>
    api.issues.comments.react({ workspaceId, ...input }),
  onSuccess: () =>
    queryClient.invalidateQueries({ queryKey: trackerKeys.comments(workspaceId, issue?.id ?? '') }),
}))

const watch = createMutation(() => ({
  mutationFn: (next: boolean) =>
    next
      ? api.issues.watchers.add({ workspaceId, issueId: issue?.id as string })
      : api.issues.watchers.remove({
          workspaceId,
          issueId: issue?.id as string,
          userId: session.user?.id as string,
        }),
  onSuccess: invalidate,
}))

const statusMenu = $derived<MenuItem[]>(
  (transitionsQuery.data ?? [])
    .filter((tr: AvailableTransition) => !tr.hidden)
    .map((tr: AvailableTransition) => ({
      id: tr.id,
      label: tr.toStatus.name,
      disabled: !tr.allowed,
      hint: tr.allowed ? undefined : (tr.reasons[0]?.message ?? undefined),
      onSelect: () => transition.mutate(tr.id),
    })),
)

const priorityMenu = $derived<MenuItem[]>(
  PRIORITY_GROUP_ORDER.map((p: Priority) => ({
    id: p,
    label: priorityLabel(p),
    icon: issue?.priority === p ? 'check' : undefined,
    onSelect: () => patch.mutate({ priority: p }),
  })),
)

const assigneeMenu = $derived<MenuItem[]>(
  cat.people.map((person) => ({
    type: 'checkbox' as const,
    id: person.id,
    label: person.name,
    // a face is recognised faster than a name, and this menu is how work is handed over
    avatar: { id: person.id, name: person.name, src: person.avatarUrl },
    checked: issue?.assigneeIds.some((id) => id === person.id) ?? false,
    onCheckedChange: (on: boolean) =>
      patch.mutate(on ? { assigneeAdd: [person.id] } : { assigneeRemove: [person.id] }),
  })),
)

const labelMenu = $derived<MenuItem[]>(
  cat.labels.map((label) => ({
    type: 'checkbox' as const,
    id: label.id,
    label: label.name,
    checked: issue?.labelIds.includes(label.id) ?? false,
    onCheckedChange: (on: boolean) =>
      patch.mutate(on ? { labelAdd: [label.id] } : { labelRemove: [label.id] }),
  })),
)

const cycleMenu = $derived<MenuItem[]>([
  { id: 'none', label: t('no_cycle'), onSelect: () => patch.mutate({ cycleId: null }) },
  { type: 'separator' as const },
  ...cat.cycles
    .filter((c) => c.status !== 'completed')
    .map((c) => ({
      id: c.id,
      label: c.name,
      icon: issue?.cycleId === c.id ? 'check' : undefined,
      onSelect: () => patch.mutate({ cycleId: c.id }),
    })),
])

/**
 * What this project estimates in.
 *
 * A project chooses points or hours — or neither — and the issue keeps the unit it was raised
 * under. The panel said "pts" whatever the project had chosen, and offered to estimate work in a
 * project whose setting is "do not estimate".
 */
const estimateUnit = $derived(estimateUnitOf(project ?? null))

const estimateMenu = $derived<MenuItem[]>([
  { id: 'none', label: t('no_estimate'), onSelect: () => patch.mutate({ estimate: null }) },
  { type: 'separator' as const },
  ...(project?.settings.estimateScale ?? [1, 2, 3, 5, 8]).map((value) => ({
    id: String(value),
    label: estimateLabel(value, estimateUnit),
    icon: issue?.estimate === value ? 'check' : undefined,
    onSelect: () => patch.mutate({ estimate: value }),
  })),
])

/** Comments and history interleaved, oldest first, the way the design shows the activity feed. */
/** Replies, grouped under the comment they answer — the feed shows only top-level comments. */
const repliesOf = $derived.by(() => {
  const byParent = new Map<string, IssueComment[]>()
  for (const c of commentsQuery.data?.items ?? []) {
    if (!c.parentId) continue
    byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c])
  }
  return byParent
})

const activity = $derived.by(() => {
  const all = commentsQuery.data?.items ?? []
  const comments = all
    .filter((c) => !c.parentId)
    .map((c) => ({ kind: 'comment' as const, at: c.createdAt, comment: c }))
  const events = (historyQuery.data?.items ?? []).map((h) => ({
    kind: 'event' as const,
    at: h.occurredAt,
    event: h,
  }))
  return [...comments, ...events].sort((a, b) => a.at.localeCompare(b.at))
})

function startEditingDescription(current: Issue) {
  descriptionDraft = current.description ?? null
  editingDescription = true
}

function saveDescription() {
  /*
   * `$state.snapshot` because the editor's document is a Svelte state proxy, and a proxy cannot be
   * passed to `structuredClone` — which is what the API layer does on the way out. Without it the
   * save threw "could not be cloned" and silently dropped the edit.
   */
  patch.mutate({ description: $state.snapshot(descriptionDraft) as RichDoc | null })
  editingDescription = false
}

function describeEvent(action: string, changes: Array<{ field: string; to: unknown }>): string {
  if (action === 'created') return t('event_created')
  const change = changes[0]
  if (action === 'status_changed' && change) {
    return t('event_status', { status: cat.status(String(change.to))?.name ?? String(change.to) })
  }
  return t('event_updated', { field: change?.field ?? '' })
}
</script>

<Sheet
  open={issueKey !== null}
  inline
  width={440}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  {#snippet header()}
    {#if issue}
      <StatusIcon
        category={issue.statusCategory}
        statusId={issue.statusId}
        name={status?.name}
        size={16}
      />
      <span class="hkey">{issue.key}</span>
      <span class="hstatus">{status?.name ?? ''}</span>
    {/if}
  {/snippet}

  <!-- The menu belongs beside the close button, not beside the title: a spacer of our own here
       and `Sheet`'s own one split the row and stranded it mid-header. -->
  {#snippet actions()}
    {#if issue}
      <DropdownMenu items={issueMenu} align="end">
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="hmore"
            aria-label={t('issue_actions')}
            data-testid="issue-actions"
          >
            <Icon name="ellipsis" size={15} strokeWidth={1.8} />
          </button>
        {/snippet}
      </DropdownMenu>
    {/if}
  {/snippet}

  {#if !issue}
    <div class="loading"><Spinner /></div>
  {:else}
    {#if confirmingDelete}
      <div class="danger" role="alertdialog" aria-label={t('issue_delete_body')}>
        <p>{t('issue_delete_body')}</p>
        <div class="drow">
          <Button
            size="sm"
            variant="danger"
            loading={deleteIssue.isPending}
            onclick={() => deleteIssue.mutate()}
            data-testid="issue-delete-confirm"
          >
            {t('common.delete')}
          </Button>
          <Button size="sm" variant="ghost" onclick={() => (confirmingDelete = false)}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    {/if}

    <h1 class="title">{issue.title}</h1>

    {#snippet row_status()}
            <dt>{t('detail_status')}</dt>
            <dd>
              <DropdownMenu items={canTransition ? statusMenu : []} align="start">
                {#snippet trigger(props)}
                  <button
                    {...props}
                    type="button"
                    class="val"
                    class:static={!canTransition}
                    disabled={!canTransition}
                    title={canTransition ? undefined : t('no_permission')}
                    data-testid="status-picker"
                  >
                    <StatusIcon
                      category={issue.statusCategory}
                      statusId={issue.statusId}
                      name={status?.name}
                      size={15}
                    />
                    {status?.name ?? issue.statusId}
                  </button>
                {/snippet}
              </DropdownMenu>
            </dd>

    {/snippet}

    {#snippet row_assignees()}
            <dt>{t('detail_assignee')}</dt>
            <dd>
              <DropdownMenu items={canEdit ? assigneeMenu : []} align="start">
                {#snippet trigger(props)}
                  <button
                    {...props}
                    type="button"
                    class="val"
                    class:static={!canEdit}
                    disabled={!canEdit}
                    title={canEdit ? undefined : t('no_permission')}>
                    {#if issue.assigneeIds.length === 0}
                      <span class="muted">{t('unassigned')}</span>
                    {:else}
                      {#each issue.assigneeIds as id (id)}
                        {@const person = cat.person(id)}
                        <Avatar name={person?.name} src={person?.avatarUrl} {id} size={22} />
                      {/each}
                      <span>{cat.person(issue.assigneeIds[0])?.name ?? ''}</span>
                      {#if issue.assigneeIds.length > 1}
                        <span class="muted">+{issue.assigneeIds.length - 1}</span>
                      {/if}
                    {/if}
                  </button>
                {/snippet}
              </DropdownMenu>
            </dd>

    {/snippet}

    {#snippet row_priority()}
            <dt>{t('detail_priority')}</dt>
            <dd>
              <DropdownMenu items={canEdit ? priorityMenu : []} align="start">
                {#snippet trigger(props)}
                  <button
                    {...props}
                    type="button"
                    class="val"
                    class:static={!canEdit}
                    disabled={!canEdit}
                    title={canEdit ? undefined : t('no_permission')}>
                    <PriorityGlyph priority={issue.priority} size={15} />
                    {priorityLabel(issue.priority)}
                  </button>
                {/snippet}
              </DropdownMenu>
            </dd>

    {/snippet}

    {#snippet row_dueDate()}
            <dt>{t('detail_due')}</dt>
            <dd>
              <label class="val date" class:static={!canEdit}>
                {#if issue.dueDate}
                  <DueDate date={issue.dueDate} />
                {:else}
                  <span class="muted">{t('no_due')}</span>
                {/if}
                <input
                  type="date"
                  value={issue.dueDate ?? ''}
                  aria-label={t('detail_due')}
                  disabled={!canEdit}
                  onchange={(e) => patch.mutate({ dueDate: e.currentTarget.value || null })}
                />
              </label>
            </dd>

    {/snippet}

    {#snippet row_labels()}
            <dt>{t('detail_labels')}</dt>
            <dd>
              <DropdownMenu items={labelMenu} align="start">
                {#snippet trigger(props)}
                  <button {...props} type="button" class="val wrap">
                    {#if issue.labelIds.length === 0}
                      <span class="muted">{t('no_label')}</span>
                    {:else}
                      {#each issue.labelIds as id (id)}
                        {@const label = cat.label(id)}
                        <span class="lbl">
                          <span class="swatch" style:background={label?.color ?? 'var(--kern-ink-330)'}></span>
                          {label?.name ?? ''}
                        </span>
                      {/each}
                    {/if}
                  </button>
                {/snippet}
              </DropdownMenu>
            </dd>

    {/snippet}

    {#snippet row_cycle()}
            <dt>{t('detail_cycle')}</dt>
            <dd>
              <DropdownMenu items={canEdit ? cycleMenu : []} align="start">
                {#snippet trigger(props)}
                  <button
                    {...props}
                    type="button"
                    class="val"
                    class:static={!canEdit}
                    disabled={!canEdit}
                    title={canEdit ? undefined : t('no_permission')}>
                    {#if cycle}{cycle.name}{:else}<span class="muted">{t('no_cycle')}</span>{/if}
                  </button>
                {/snippet}
              </DropdownMenu>
            </dd>

    {/snippet}

    {#snippet row_estimate()}
            <dt>{t('detail_estimate')}</dt>
            <dd>
              <DropdownMenu items={canEdit ? estimateMenu : []} align="start">
                {#snippet trigger(props)}
                  <button
                    {...props}
                    type="button"
                    class="val"
                    class:static={!canEdit}
                    disabled={!canEdit}
                    title={canEdit ? undefined : t('no_permission')}>
                    {#if issue.estimate !== null}
                      {estimateLabel(issue.estimate, issue.estimateUnit)}
                    {:else}
                      <span class="muted">{t('no_estimate')}</span>
                    {/if}
                  </button>
                {/snippet}
              </DropdownMenu>
            </dd>

    {/snippet}

    {#snippet row_project()}
            <dt>{t('detail_project')}</dt>
            <dd><span class="val static">{project?.name ?? ''}</span></dd>
    {/snippet}

    <dl class="props">
      <!-- Dispatched by field id: the layout decides which rows appear and in what order, and each
           built-in control is the same one the panel always had. -->
      {#each sidebarFields as f (f.fieldId)}
        {#if f.fieldId === 'status'}
          {@render row_status()}
        {:else if f.fieldId === 'assignees'}
          {@render row_assignees()}
        {:else if f.fieldId === 'priority'}
          {@render row_priority()}
        {:else if f.fieldId === 'dueDate'}
          {@render row_dueDate()}
        {:else if f.fieldId === 'labels'}
          {@render row_labels()}
        {:else if f.fieldId === 'cycle'}
          {@render row_cycle()}
        {:else if f.fieldId === 'estimate'}
          <!-- A project that estimates in nothing is not offered an estimate to set. -->
          {#if estimateUnit !== 'none' || issue.estimate !== null}
            {@render row_estimate()}
          {/if}
        {:else if f.fieldId === 'project'}
          {@render row_project()}
        {:else if f.kind === 'custom' && f.field}
          <dt>{f.label}</dt>
          <dd>
            <CustomField
              field={f.field}
              value={issue.custom?.[f.field.key] ?? null}
              editable={canEdit}
              required={f.required}
              {workspaceId}
              issueId={issue.id}
              onchange={(value) => patch.mutate({ custom: { [f.field!.key]: value } })}
            />
          </dd>
        {/if}
      {/each}
    </dl>

    <IssueTime {workspaceId} issueId={issue.id} canLog={canEdit} />

    <IssueApprovals
      {workspaceId}
      issueId={issue.id}
      oninvalidate={() => {
        invalidate()
        void queryClient.invalidateQueries({
          queryKey: trackerKeys.transitions(workspaceId, issue.id),
        })
      }}
    />

    <IssueConnections
      {workspaceId}
      {issue}
      {canEdit}
      onopen={onopenissue}
    />

    {#if issueAttachments.length || canEdit}
      <section class="attachments">
        <div class="ahead">
          <span class="kern-sublabel">{t('attachments')}</span>
          {#if canEdit}
            <input
              bind:this={issueFileInput}
              type="file"
              multiple
              hidden
              onchange={(e) => {
                void uploadIssueFiles(e.currentTarget.files)
                e.currentTarget.value = ''
              }}
            />
            <IconButton
              icon="paperclip"
              size={26}
              label={t('attach_file')}
              onclick={() => issueFileInput?.click()}
            />
          {/if}
        </div>
        {#if issueAttachments.length}
          <ul class="afiles">
            {#each issueAttachments as file (file.id)}
              <li>
                <Icon name="paperclip" size={13} strokeWidth={1.8} />
                <span class="aname" title={file.name}>{file.name}</span>
                <span class="asize">{formatBytes(file.size)}</span>
                {#if canEdit}
                  <IconButton
                    icon="x"
                    size={22}
                    label={t('attachment_remove')}
                    onclick={() => removeAttachment.mutate(file.id)}
                  />
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">{t('attachments_empty')}</p>
        {/if}
      </section>
    {/if}

    {#if issue.triage && canTriage}
      <section class="triage" data-testid="triage">
        <div class="thead">
          <Icon name="inbox" size={14} strokeWidth={1.8} />
          <span>{t('triage_waiting')}</span>
        </div>
        <p class="tnote">{t('triage_hint')}</p>
        <div class="row">
          <Button
            size="sm"
            disabled={triage.isPending}
            onclick={() => triage.mutate({ action: 'accept' })}
            data-testid="triage-accept"
          >
            {t('triage_accept')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={triage.isPending}
            onclick={() => triage.mutate({ action: 'snooze', until: nextWeek() })}
          >
            {t('triage_snooze')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={triage.isPending}
            onclick={() => triage.mutate({ action: 'decline' })}
            data-testid="triage-decline"
          >
            {t('triage_decline')}
          </Button>
        </div>
      </section>
    {/if}

    {#if mainFields.length}
      <dl class="props main" data-testid="main-fields">
        {#each mainFields as f (f.fieldId)}
          <dt>{f.label}</dt>
          <dd>
            <CustomField
              field={f.field!}
              value={issue.custom?.[f.field!.key] ?? null}
              editable={canEdit}
              required={f.required}
              {workspaceId}
              issueId={issue.id}
              onchange={(value) => patch.mutate({ custom: { [f.field!.key]: value } })}
            />
          </dd>
        {/each}
      </dl>
    {/if}

    <section class="desc">
      {#if editingDescription}
        <RichTextEditor
          bind:value={descriptionDraft}
          minRows={6}
          autofocus
          label={t('detail_description')}
          placeholder={t('no_description')}
          onsubmit={saveDescription}
          onescape={() => (editingDescription = false)}
        />
        <div class="row">
          <Button size="sm" onclick={saveDescription}>{t('common.save')}</Button>
          <Button size="sm" variant="ghost" onclick={() => (editingDescription = false)}>
            {t('common.cancel')}
          </Button>
        </div>
      {:else}
        <button
          type="button"
          class="kern-prose prose"
          disabled={!canEdit}
          onclick={() => startEditingDescription(issue)}
        >
          {#if issue.description}
            <!-- rendered from stored ProseMirror JSON; see richtext.ts for the allowed nodes -->
            {@html renderDoc(issue.description)}
          {:else}
            <span class="muted">{t('no_description')}</span>
          {/if}
        </button>
      {/if}
    </section>

    <section class="activity">
      <div class="arow">
        <span class="kern-sublabel">{t('activity')}</span>
        <span class="sp"></span>
        <button type="button" class="watch" onclick={() => watch.mutate(!watching)}>
          <Icon name={watching ? 'eye' : 'eye-off'} size={13} strokeWidth={1.6} />
          {watching ? t('watching', { count: issue.watcherIds.length }) : t('watch')}
        </button>
      </div>

      {#each activity as entry (entry.kind === 'comment' ? entry.comment.id : entry.event.id)}
        {#if entry.kind === 'comment'}
          <CommentThread
            {workspaceId}
            comment={entry.comment}
            replies={repliesOf.get(entry.comment.id) ?? []}
            attachments={attachmentsByComment.get(entry.comment.id) ?? []}
            {canComment}
            onreact={(commentId, emoji) => react.mutate({ commentId, emoji })}
            onedit={(commentId, body) => editComment.mutate({ commentId, body: body as RichDoc })}
            ondelete={(commentId) => deleteComment.mutate(commentId)}
            onreply={(parentId, body, fileIds) =>
              comment.mutate({ body: body as RichDoc, fileIds, internal: false, parentId })}
            onremoveAttachment={(attachmentId) => removeAttachment.mutate(attachmentId)}
          />
        {:else}
          {@const person = cat.person(entry.event.actorId)}
          <div class="event">
            <span class="ename">{person?.name ?? t('common.system')}</span>
            {describeEvent(entry.event.action, entry.event.changes)}
            <time datetime={entry.event.occurredAt}>{relativeTime(entry.event.occurredAt)}</time>
          </div>
        {/if}
      {/each}
    </section>
  {/if}

  {#snippet footer()}
    {#if canComment}
      <CommentComposer
        {workspaceId}
        busy={comment.isPending}
        onsubmit={(body, fileIds, internal) => comment.mutate({ body, fileIds, internal })}
      />
    {:else}
      <p class="no-comment">{t('no_permission')}</p>
    {/if}
  {/snippet}
</Sheet>

<style>
  .triage {
    margin-top: 14px;
    padding: 10px 12px;
    border: 1px solid var(--kern-warning);
    border-radius: var(--kern-r-sm);
    background: var(--kern-warning-tint, var(--kern-shell));
  }
  .thead {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .tnote {
    margin: 3px 0 8px;
    font-size: 12px;
    color: var(--kern-ink-450, var(--kern-ink-400));
  }
  .triage .row {
    display: flex;
    gap: 6px;
  }
  .attachments {
    margin-top: 16px;
  }
  .ahead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .afiles {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .afiles li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .aname {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .asize {
    color: var(--kern-ink-350);
    font-size: 12px;
  }
  .empty,
  .no-comment {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--kern-ink-350);
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 40px;
  }
  .hkey {
    font-family: var(--kern-font-mono);
    font-size: 12px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-300);
  }
  .hstatus {
    font-size: 13px;
    color: var(--kern-ink-550);
  }
.hmore {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: var(--kern-ink-500);
  cursor: pointer;
}
.hmore:hover {
  background: var(--kern-surface-hover);
}
.danger {
  margin: 0 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--kern-danger);
  border-radius: var(--kern-r-sm);
  font-size: 12.5px;
}
.danger p {
  margin: 0 0 8px;
}
.drow {
  display: flex;
  gap: 8px;
}
.title {
    margin: 0;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.32;
    letter-spacing: -0.02em;
    color: var(--kern-ink-900);
    text-wrap: pretty;
  }
  .props.main {
    margin-top: 14px;
  }
  .props {
    display: grid;
    grid-template-columns: 84px 1fr;
    align-items: center;
    gap: 10px 12px;
    margin: 18px 0 0;
    font-size: 13px;
  }
  .props dt {
    color: var(--kern-ink-350);
  }
  .props dd {
    margin: 0;
    min-width: 0;
  }
  .val {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
    max-width: 100%;
    padding: 2px 6px;
    margin-inline-start: -6px;
    border-radius: var(--kern-r-md);
    color: var(--kern-ink-700);
    text-align: start;
  }
  .val:not(.static):hover {
    background: var(--kern-surface-hover);
  }
  .val.static,
  .val:disabled {
    cursor: default;
  }
  .prose:disabled {
    cursor: default;
  }
  .prose:disabled:hover {
    background: transparent;
  }
  .val.wrap {
    flex-wrap: wrap;
  }
  .val.date {
    position: relative;
    cursor: pointer;
  }
  .val.date input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
  }
  .muted {
    color: var(--kern-ink-350);
  }
  .lbl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: var(--kern-r-md);
    background: var(--kern-surface-chip);
    color: var(--kern-ink-520);
  }
  .swatch {
    width: 8px;
    height: 8px;
    border-radius: var(--kern-r-full);
  }
  .desc {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid var(--kern-border-hairline);
  }
  /* The read view of the description. Everything typographic now comes from
     `@kernhq/ui/styles/prose.css` — the same sheet the editor wears — so switching between reading
     and editing does not move a single line. What is left here is the button it happens to be. */
  .prose {
    display: block;
    width: 100%;
    text-align: start;
    font-size: 14px;
    border-radius: var(--kern-r-lg);
  }
  .prose:hover {
    background: var(--kern-surface-hover);
  }
  .row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .activity {
    margin-top: 22px;
    padding-top: 16px;
    border-top: 1px solid var(--kern-border-hairline);
  }
  .arow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .sp {
    flex: 1;
  }
  .watch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--kern-ink-400);
    padding: 3px 7px;
    border-radius: var(--kern-r-md);
  }
  .watch:hover {
    background: var(--kern-surface-hover);
    color: var(--kern-ink-700);
  }
  .thread {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 10px;
    margin-bottom: 16px;
  }
  .thead {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .author {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--kern-ink-900);
  }
  .thead time,
  .event time {
    font-size: 12px;
    color: var(--kern-ink-280);
  }
  .tprose {
    font-size: 13.5px;
    margin-top: 3px;
  }
  .reactions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }
  .reaction {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border-radius: var(--kern-r-md);
    background: var(--kern-surface-chip);
    color: var(--kern-ink-520);
    font-size: 12px;
  }
  .reaction.mine {
    background: var(--kern-accent-tint);
    color: var(--kern-accent-deep);
  }
  .reaction.add {
    background: transparent;
    color: var(--kern-ink-350);
  }
  .reaction.add:hover {
    background: var(--kern-surface-hover);
  }
  .event {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 14px 38px;
    font-size: 12.5px;
    color: var(--kern-ink-450);
  }
  :global([dir='rtl']) .event {
    margin: 0 38px 14px 0;
  }
  .ename {
    font-weight: 500;
    color: var(--kern-ink-700);
  }
  .reply input {
    width: 100%;
    height: 36px;
    border: 1px solid var(--kern-border-strong);
    border-radius: var(--kern-r-lg);
    background: var(--kern-surface-raised);
    padding: 0 12px;
    font-size: 13.5px;
    color: var(--kern-ink-800);
  }
</style>
