import { navigation, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import type { Project } from '../index.js'
import { trackerKeys } from '../query.js'

/**
 * The project a page is about, taken from the URL.
 *
 * Every one of a project's pages needs the same three things — the workspace, the project and
 * whether it has arrived yet — and they must not each resolve them differently. The list itself is
 * one query the whole tracker shares, so asking for it here costs nothing beyond the first page.
 */
export interface RouteProject {
  readonly slug: string
  readonly workspaceId: string
  readonly projectKey: string
  readonly project: Project | null
  readonly projectId: string
  readonly pending: boolean
}

export function useRouteProject(): RouteProject {
  const api = getTrackerApi()

  const slug = $derived(navigation.workspaceSlug)
  const workspaceId = $derived(session.workspaces.find((w) => w.slug === slug)?.id ?? '')
  const projectKey = $derived((navigation.params.key ?? '').toUpperCase())

  const projectsQuery = createQuery(() => ({
    queryKey: trackerKeys.projects(workspaceId),
    queryFn: () => api.projects.list({ workspaceId }),
    enabled: Boolean(workspaceId),
  }))

  const project = $derived((projectsQuery.data ?? []).find((p) => p.key === projectKey) ?? null)

  return {
    get slug() {
      return slug
    },
    get workspaceId() {
      return workspaceId
    },
    get projectKey() {
      return projectKey
    },
    get project() {
      return project
    },
    get projectId() {
      return project?.id ?? ''
    },
    get pending() {
      return projectsQuery.isPending
    },
  }
}
