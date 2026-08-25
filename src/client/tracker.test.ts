import { describe, expect, it } from 'vitest'
import { composeKql, emptyFilters, filtersToKql } from './filters.js'
/**
 * Named by file, not through the barrel.
 *
 * `index.ts` re-exports the client module, which reaches Svelte components and the framework's
 * rune-backed singletons — so importing a pure helper through it fails with "$state is not defined"
 * in a test that has nothing to do with components.
 */
import { statusStyle } from './format.js'
import { type GroupContext, groupIssues } from './group.js'
import { parseKql } from './kql.js'
import { createMockTrackerApi } from './mock.js'
import { byRank, rankBetween, rankForIndex, rankSequence } from './rank.js'
import { docFromText, renderDoc, textFromDoc } from './richtext.js'
import type { Issue } from './types.js'

const WORKSPACE = '01920000-0000-7000-8000-000000000010'

describe('rank (fractional index)', () => {
  it('always lands strictly between its neighbours', () => {
    let low = rankBetween(null, null)
    let high = rankBetween(low, null)
    // repeatedly inserting into the same gap must keep converging, never collide
    for (let i = 0; i < 200; i++) {
      const mid = rankBetween(low, high)
      expect(low < mid).toBe(true)
      expect(mid < high).toBe(true)
      if (i % 2 === 0) high = mid
      else low = mid
    }
  })

  it('orders an inserted item the way the drop looked', () => {
    const items = rankSequence(5).map((rank) => ({ rank }))
    const moved = { rank: rankForIndex(items, 2) }
    const sorted = [...items, moved].sort(byRank)
    expect(sorted.indexOf(moved)).toBe(2)
  })

  it('puts an open-ended insert outside the list', () => {
    const [first, last] = [rankBetween(null, null), rankBetween(rankBetween(null, null), null)]
    expect(rankBetween(null, first) < first).toBe(true)
    expect(rankBetween(last, null) > last).toBe(true)
  })

  it('refuses a reversed range rather than minting a colliding key', () => {
    expect(() => rankBetween('b', 'a')).toThrow()
  })
})

describe('KQL', () => {
  it('accepts the queries the interface builds', () => {
    for (const query of [
      '',
      'assignee = currentUser()',
      'statusCategory in (todo, in_progress)',
      'priority = urgent and label = "good first issue"',
      'due <= +7d or due is empty',
      'not (status = done) order by priority desc, updated',
      'text ~ "voice rooms"',
    ]) {
      const parsed = parseKql(query)
      expect(parsed.errors, `${query}: ${parsed.errors.map((e) => e.message).join('; ')}`).toEqual([])
      expect(parsed.ok).toBe(true)
    }
  })

  it('reports an unknown field with the span to underline', () => {
    const parsed = parseKql('assigne = currentUser()')
    expect(parsed.ok).toBe(false)
    expect(parsed.errors[0]?.message).toContain('assigne')
    expect(parsed.errors[0]).toMatchObject({ start: 0, end: 7 })
  })

  it('rejects an operator a field does not support', () => {
    const parsed = parseKql('assignee ~ maya')
    expect(parsed.ok).toBe(false)
    expect(parsed.errors[0]?.message).toContain('~')
  })

  it('rejects a value outside an enum', () => {
    expect(parseKql('priority = catastrophic').ok).toBe(false)
    expect(parseKql('priority = urgent').ok).toBe(true)
  })

  it('normalises what it parsed, so a saved view round-trips', () => {
    const parsed = parseKql('PRIORITY   =    urgent   and status=done')
    expect(parsed.normalized).toBe('priority = urgent and status = done')
  })

  it('suggests fields first and values once a field is chosen', () => {
    expect(parseKql('', { cursor: 0 }).suggestions.some((s) => s.kind === 'field')).toBe(true)
    const values = parseKql('priority = ', { cursor: 11 }).suggestions
    expect(values.some((s) => s.kind === 'value' && s.label === 'urgent')).toBe(true)
  })
})

describe('grouping', () => {
  const issue = (over: Partial<Issue>): Issue =>
    ({
      id: over.id ?? 'i',
      statusId: 'todo',
      statusCategory: 'todo',
      priority: 'none',
      assigneeIds: [],
      labelIds: [],
      componentIds: [],
      versionIds: [],
      typeId: 't',
      cycleId: null,
      milestoneId: null,
      projectId: 'p',
      parentId: null,
      dueDate: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      estimate: null,
      rank: 'a',
      ...over,
    }) as Issue

  const ctx: GroupContext = {
    statusOrder: (id) => ({ triage: 0, todo: 1, in_progress: 2, done: 3 })[id] ?? 9,
    statusCategory: (id) =>
      (({ triage: 'triage', todo: 'todo', in_progress: 'in_progress', done: 'done' }) as const)[id] ?? 'todo',
  }

  it('orders status groups triage first and finished work last', () => {
    const groups = groupIssues(
      [
        issue({ id: '1', statusId: 'done', statusCategory: 'done' }),
        issue({ id: '2', statusId: 'triage', statusCategory: 'triage' }),
        issue({ id: '3', statusId: 'in_progress', statusCategory: 'in_progress' }),
      ],
      'status',
      ctx,
    )
    expect(groups.map((g) => g.key)).toEqual(['triage', 'in_progress', 'done'])
  })

  it('puts a multi-assignee issue in every assignee group and unassigned work in its own', () => {
    const groups = groupIssues(
      [issue({ id: '1', assigneeIds: ['a', 'b'] as unknown as Issue['assigneeIds'] }), issue({ id: '2' })],
      'assignee',
      ctx,
    )
    expect(groups.map((g) => g.key)).toEqual(['a', 'b', null])
    expect(groups.at(-1)?.items.map((i) => i.id)).toEqual(['2'])
  })

  it('hides empty groups but keeps the board columns you can drop into', () => {
    expect(groupIssues([], 'status', ctx)).toHaveLength(0)
    const withColumns = groupIssues([], 'status', ctx, { alwaysShow: ['todo', 'done'] })
    expect(withColumns.map((g) => g.key)).toEqual(['todo', 'done'])
  })

  it('sums estimates per group and leaves unestimated groups blank', () => {
    const groups = groupIssues(
      [issue({ id: '1', estimate: 3 }), issue({ id: '2', estimate: 5 }), issue({ id: '3' })],
      'status',
      ctx,
    )
    expect(groups[0]?.estimate).toBe(8)
    expect(groupIssues([issue({ id: '4' })], 'status', ctx)[0]?.estimate).toBeNull()
  })
})

describe('status presentation', () => {
  it('gives a review step its own colour without inventing a category', () => {
    expect(statusStyle('in_progress', 'in_progress').visual).toBe('in_progress')
    expect(statusStyle('in_progress', 'in_review').visual).toBe('in_review')
    expect(statusStyle('triage').dash).not.toBeNull()
    expect(statusStyle('done').fill).not.toBeNull()
  })
})

describe('filters', () => {
  it('quotes ids so a uuid is not read as a number', () => {
    const kql = filtersToKql({ ...emptyFilters(), projectIds: ['0192-abc'] })
    expect(kql).toBe('project = "0192-abc"')
  })

  it('combines the preset, the filter menu and what was typed', () => {
    const kql = composeKql('assigned', { ...emptyFilters(), priorities: ['urgent', 'high'] }, 'due <= +7d')
    expect(kql).toBe('assignee = currentUser() and priority in (urgent, high) and due <= +7d')
    expect(parseKql(kql).ok).toBe(true)
  })

  it('is empty when nothing is chosen, which matches everything', () => {
    expect(composeKql('all', emptyFilters(), '')).toBe('')
  })

  it('brackets a typed "or" so it cannot swallow the preset — whatever its case', () => {
    for (const typed of ['priority = urgent or priority = high', 'priority = urgent OR priority = high']) {
      const kql = composeKql('assigned', emptyFilters(), typed)
      expect(kql).toBe(`assignee = currentUser() and (${typed})`)
      const parsed = parseKql(kql)
      expect(parsed.ok).toBe(true)
      // the whole query is an `and`: without the brackets the top level would be `or`
      expect(parsed.ast?.where?.kind).toBe('and')
    }
  })

  it('leaves an "or" inside a value alone — it is text, not an operator', () => {
    expect(composeKql('assigned', emptyFilters(), 'title ~ "editor or reviewer"')).toBe(
      'assignee = currentUser() and title ~ "editor or reviewer"',
    )
  })

  it('does not bracket a lone part, so a plain query stays readable', () => {
    expect(composeKql('all', emptyFilters(), 'priority = urgent or priority = high')).toBe(
      'priority = urgent or priority = high',
    )
  })
})

describe('rich text', () => {
  it('escapes text rather than trusting it', () => {
    const doc = docFromText('<script>alert(1)</script>')
    expect(renderDoc(doc)).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('drops a link that does not navigate anywhere safe', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:evil()' } }] },
          ],
        },
      ],
    }
    expect(renderDoc(doc)).toBe('<p>click</p>')
  })

  it('round-trips paragraphs through the editor', () => {
    const text = 'First paragraph.\n\nSecond paragraph.'
    expect(textFromDoc(docFromText(text))).toBe(text)
  })

  it('renders a mention instead of dropping it', () => {
    // A mention is an inline leaf with no children, so the renderer's default branch produced an
    // empty string and whoever was mentioned vanished from the comment.
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'over to ' },
            { type: 'mention', attrs: { kind: 'user', id: 'u-1', label: 'Dan Brekke' } },
          ],
        },
      ],
    }
    expect(renderDoc(doc)).toBe(
      '<p>over to <span class="kern-mention" data-user-id="u-1">@Dan Brekke</span></p>',
    )
  })

  it('keeps a mention when a comment is edited', () => {
    // The edit box is text, so a mention that does not survive `textFromDoc` is deleted by the act
    // of editing the sentence around it.
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'over to ' },
            { type: 'mention', attrs: { kind: 'user', id: 'u-1', label: 'Dan Brekke' } },
          ],
        },
      ],
    }
    expect(textFromDoc(doc)).toBe('over to @Dan Brekke')
  })
})

describe('mock backend', () => {
  it('answers a KQL query the way the interface asks it', async () => {
    const api = createMockTrackerApi()
    const all = await api.issues.query({ workspaceId: WORKSPACE })
    expect(all.items.length).toBeGreaterThan(30)

    const urgent = await api.issues.query({ workspaceId: WORKSPACE, kql: 'priority = urgent' })
    expect(urgent.items.length).toBeGreaterThan(0)
    expect(urgent.items.every((i) => i.priority === 'urgent')).toBe(true)

    const mine = await api.issues.query({ workspaceId: WORKSPACE, kql: 'assignee = currentUser()' })
    expect(mine.items.length).toBeGreaterThan(0)

    const byProjectKey = await api.issues.query({ workspaceId: WORKSPACE, kql: 'project = KRN' })
    expect(byProjectKey.items.every((i) => i.key.startsWith('KRN-'))).toBe(true)
  })

  it('moves an issue through a transition and records it in the history', async () => {
    const api = createMockTrackerApi()
    const { items } = await api.issues.query({ workspaceId: WORKSPACE, kql: 'status = todo' })
    const issue = items[0]
    expect(issue).toBeDefined()
    if (!issue) return

    const transitions = await api.issues.transitions.available({ workspaceId: WORKSPACE, issueId: issue.id })
    const toReview = transitions.find((t) => t.toStatusId === 'in_review')
    expect(toReview).toBeDefined()
    if (!toReview) return

    const applied = await api.issues.transitions.apply({
      workspaceId: WORKSPACE,
      issueId: issue.id,
      transitionId: toReview.id,
    })
    expect(applied.issue.statusId).toBe('in_review')

    const history = await api.issues.history({ workspaceId: WORKSPACE, issueId: issue.id })
    expect(history.items.some((h) => h.action === 'status_changed')).toBe(true)
  })

  it('parks a close behind an approval and applies it once approved', async () => {
    // Closing needs a sign-off in the demo data, so an approval is something you can see and
    // decide rather than a screen nobody ever reaches.
    const api = createMockTrackerApi()
    const { items } = await api.issues.query({ workspaceId: WORKSPACE, kql: 'status = todo' })
    const issue = items[0]
    expect(issue).toBeDefined()
    if (!issue) return

    const transitions = await api.issues.transitions.available({ workspaceId: WORKSPACE, issueId: issue.id })
    const toDone = transitions.find((t) => t.toStatusId === 'done')
    expect(toDone?.requiresApproval).toBe(true)
    if (!toDone) return

    const parked = await api.issues.transitions.apply({
      workspaceId: WORKSPACE,
      issueId: issue.id,
      transitionId: toDone.id,
    })
    expect(parked.approval).toBeTruthy()
    expect(parked.issue.statusId).toBe('todo')

    const waiting = await api.issues.approvals.list({ workspaceId: WORKSPACE, issueId: issue.id })
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.state.status).toBe('pending')

    const decided = await api.issues.approvals.decide({
      workspaceId: WORKSPACE,
      issueId: issue.id,
      transitionId: toDone.id,
      decision: 'approve',
    })
    expect(decided.approval.state.status).toBe('approved')
    expect(decided.issue?.statusId).toBe('done')
    expect(decided.issue?.completedAt).not.toBeNull()
  })

  it('creates an issue with the next key in its project', async () => {
    const api = createMockTrackerApi()
    const projects = await api.projects.list({ workspaceId: WORKSPACE })
    const project = projects[0]
    expect(project).toBeDefined()
    if (!project) return

    const before = await api.issues.query({ workspaceId: WORKSPACE, kql: `project = "${project.id}"` })
    const created = await api.issues.create({
      workspaceId: WORKSPACE,
      projectId: project.id,
      title: 'Written by a test',
    })
    expect(created.key).toBe(`${project.key}-${before.items.length + 1}`)

    const after = await api.issues.query({ workspaceId: WORKSPACE, kql: 'text ~ "Written by a test"' })
    expect(after.items).toHaveLength(1)
  })

  it('toggles a reaction off when the same person reacts twice', async () => {
    const api = createMockTrackerApi()
    const { items } = await api.issues.query({ workspaceId: WORKSPACE })
    const issue = items.find((i) => i.commentCount > 0)
    expect(issue).toBeDefined()
    if (!issue) return

    const comments = await api.issues.comments.list({ workspaceId: WORKSPACE, issueId: issue.id })
    const comment = comments.items[0]
    expect(comment).toBeDefined()
    if (!comment) return

    const on = await api.issues.comments.react({ workspaceId: WORKSPACE, commentId: comment.id, emoji: '🎉' })
    expect(on.reactions.find((r) => r.emoji === '🎉')?.count).toBe(1)
    const off = await api.issues.comments.react({
      workspaceId: WORKSPACE,
      commentId: comment.id,
      emoji: '🎉',
    })
    expect(off.reactions.find((r) => r.emoji === '🎉')).toBeUndefined()
  })
})
