<script lang="ts">
import { Button, Icon, relativeTime, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import type { IssueApproval } from '../index.js'
import { trackerKeys } from '../query.js'

/**
 * Approvals waiting on somebody.
 *
 * `approvals.list` and `approvals.decide` have existed since transitions did, and nobody could see
 * an approval, let alone decide one — so a transition that needed approval simply stopped.
 *
 * Whether *you* may decide is a question only the server can answer: approvers are subjects
 * (a user, a group, a role, the project lead), and expanding them here would duplicate the rule
 * and eventually disagree with it. So the controls are offered and a refusal is reported plainly.
 */
interface Props {
  workspaceId: string
  issueId: string
  /** invalidated when a decision applies the transition and moves the issue */
  oninvalidate: () => void
}
let { workspaceId, issueId, oninvalidate }: Props = $props()

const api = getTrackerApi()
const cat = getTrackerCatalogue()
const queryClient = useQueryClient()

let comment = $state('')
let deciding = $state<string | null>(null)

const approvalsQuery = createQuery(() => ({
  queryKey: trackerKeys.approvals(workspaceId, issueId),
  queryFn: () => api.issues.approvals.list({ workspaceId, issueId }),
}))

/** Only pending ones need a decision; a settled approval is history, and history has its own feed. */
const pending = $derived((approvalsQuery.data ?? []).filter((a) => a.state.status === 'pending'))

const decide = createMutation(() => ({
  mutationFn: (input: { transitionId: string; decision: 'approve' | 'reject' }) =>
    api.issues.approvals.decide({
      workspaceId,
      issueId,
      transitionId: input.transitionId,
      decision: input.decision,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    }),
  onSuccess: () => {
    comment = ''
    deciding = null
    void queryClient.invalidateQueries({ queryKey: trackerKeys.approvals(workspaceId, issueId) })
    oninvalidate()
  },
  onError: (error: Error) => toast.error(error.message),
}))

const approvedCount = (approval: IssueApproval) =>
  approval.state.decisions.filter((d) => d.decision === 'approve').length
const name = (userId: string | null) => (userId ? (cat.person(userId)?.name ?? userId) : '')
</script>

{#if pending.length}
  <section class="approvals" data-testid="approvals">
    <span class="kern-sublabel">{t('approvals')}</span>
    {#each pending as approval (approval.id)}
      <div class="card">
        <div class="chead">
          <Icon name="shield-check" size={14} strokeWidth={1.8} />
          <span class="what">{t('approval_needed', { transition: approval.state.transitionId })}</span>
        </div>
        <p class="meta">
          {t('approval_progress', {
            approved: approvedCount(approval),
            needed: approval.state.spec.minApprovals,
          })}
          ·
          {t('approval_requested', {
            who: name(approval.state.requestedBy),
            when: relativeTime(approval.state.requestedAt),
          })}
        </p>

        {#if approval.state.decisions.length}
          <ul class="decisions">
            {#each approval.state.decisions as decision (decision.userId + decision.at)}
              <li>
                <Icon
                  name={decision.decision === 'approve' ? 'check' : 'x'}
                  size={12}
                  strokeWidth={2}
                />
                <span>{name(decision.userId)}</span>
                {#if decision.comment}<span class="dcomment">{decision.comment}</span>{/if}
                <time datetime={decision.at}>{relativeTime(decision.at)}</time>
              </li>
            {/each}
          </ul>
        {/if}

        {#if deciding === approval.id}
          <textarea
            bind:value={comment}
            rows="2"
            placeholder={t('approval_comment')}
            aria-label={t('approval_comment')}
          ></textarea>
        {/if}

        <div class="row">
          <Button
            size="sm"
            disabled={decide.isPending}
            onclick={() => decide.mutate({ transitionId: approval.state.transitionId, decision: 'approve' })}
          >
            {t('approval_approve')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            onclick={() => decide.mutate({ transitionId: approval.state.transitionId, decision: 'reject' })}
          >
            {t('approval_reject')}
          </Button>
          {#if deciding !== approval.id}
            <button type="button" class="addnote" onclick={() => (deciding = approval.id)}>
              {t('approval_add_comment')}
            </button>
          {/if}
        </div>
        <p class="who">{t('approval_who')}</p>
      </div>
    {/each}
  </section>
{/if}

<style>
.approvals {
  display: block;
  margin-top: 16px;
}
.card {
  margin-top: 6px;
  padding: 10px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-shell);
}
.chead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
.meta,
.who {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--kern-ink-350);
}
.decisions {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.decisions li {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}
.dcomment {
  color: var(--kern-ink-350);
}
textarea {
  width: 100%;
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  color: inherit;
  font: inherit;
  font-size: 13px;
  resize: vertical;
}
textarea:focus-visible {
  outline: none;
  border-color: var(--kern-accent);
  box-shadow: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.addnote {
  border: 0;
  background: none;
  color: var(--kern-ink-350);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.addnote:hover {
  color: var(--kern-ink-900);
}
</style>
