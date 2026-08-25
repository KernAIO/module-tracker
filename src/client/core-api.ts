import type { core } from '@kernhq/contracts'

/**
 * The slice of core's API tracker reaches for, named by shape.
 *
 * Tracker needs the workspace's members to fill an assignee picker and draw an avatar on a row.
 * Typing the seam structurally keeps the dependency pointing one way: tracker does not import
 * core's router type, and core does not know tracker exists.
 */
export interface CoreMember {
  userId: string
  user: {
    id: string
    name: string | null
    email: string
    username?: string | null
    avatarUrl?: string | null
  }
}

export interface CoreApi {
  workspaces: {
    members: {
      list(input: { workspaceId: string; limit?: number }): Promise<{ items: CoreMember[] }>
    }
  }
  files: {
    downloadUrl(input: {
      id: string
      disposition?: 'inline' | 'attachment'
      thumbnail?: boolean
    }): Promise<{ url: string }>
    get(input: { id: string }): Promise<core.FileObject>
  }
}
