import { defineEvent, Id, UserId, WorkspaceId } from '@kernhq/contracts'
import { z } from 'zod'
import { IssueKey, Priority, StatusCategory } from './models.js'

const issueRef = z.object({
  workspaceId: WorkspaceId,
  projectId: Id,
  issueId: Id,
  key: IssueKey,
})

/** Events published by the tracker module (also available as automation triggers). */
export const trackerEvents = {
  issueCreated: defineEvent(
    'tracker.issue.created',
    issueRef.extend({
      typeId: Id,
      title: z.string(),
      statusId: z.string(),
      priority: Priority,
      assigneeIds: z.array(UserId),
      triage: z.boolean(),
      source: z.string(),
    }),
  ),
  issueUpdated: defineEvent(
    'tracker.issue.updated',
    issueRef.extend({
      changes: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
    }),
  ),
  issueStatusChanged: defineEvent(
    'tracker.issue.status_changed',
    issueRef.extend({
      fromStatusId: z.string().nullable(),
      toStatusId: z.string(),
      fromCategory: StatusCategory.nullable(),
      toCategory: StatusCategory,
      transitionId: z.string().nullable(),
      resolution: z.string().nullable(),
    }),
  ),
  issueAssigned: defineEvent(
    'tracker.issue.assigned',
    issueRef.extend({ assigneeIds: z.array(UserId), added: z.array(UserId), removed: z.array(UserId) }),
  ),
  issueCommented: defineEvent(
    'tracker.issue.commented',
    issueRef.extend({ commentId: Id, parentId: Id.nullable(), authorId: UserId.nullable() }),
  ),
  issueDeleted: defineEvent('tracker.issue.deleted', issueRef),
  issueArchived: defineEvent('tracker.issue.archived', issueRef.extend({ archived: z.boolean() })),
  issueDue: defineEvent(
    'tracker.issue.due',
    issueRef.extend({ dueDate: z.string(), assigneeIds: z.array(UserId) }),
  ),

  cycleStarted: defineEvent(
    'tracker.cycle.started',
    z.object({ workspaceId: WorkspaceId, projectId: Id, cycleId: Id, number: z.number().int() }),
  ),
  cycleCompleted: defineEvent(
    'tracker.cycle.completed',
    z.object({
      workspaceId: WorkspaceId,
      projectId: Id,
      cycleId: Id,
      number: z.number().int(),
      carriedOver: z.number().int(),
    }),
  ),

  projectCreated: defineEvent(
    'tracker.project.created',
    z.object({ workspaceId: WorkspaceId, projectId: Id, key: z.string(), name: z.string() }),
  ),
  projectUpdated: defineEvent(
    'tracker.project.updated',
    z.object({ workspaceId: WorkspaceId, projectId: Id, changes: z.array(z.string()) }),
  ),
  projectArchived: defineEvent(
    'tracker.project.archived',
    z.object({ workspaceId: WorkspaceId, projectId: Id, archived: z.boolean() }),
  ),
  projectDeleted: defineEvent(
    'tracker.project.deleted',
    z.object({ workspaceId: WorkspaceId, projectId: Id, key: z.string() }),
  ),

  versionReleased: defineEvent(
    'tracker.version.released',
    z.object({ workspaceId: WorkspaceId, projectId: Id, versionId: Id, name: z.string() }),
  ),
}
