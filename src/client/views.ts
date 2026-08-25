import type { View } from './types.js'

/**
 * A saved view as a URL.
 *
 * The page reads its state from the query string, so opening a view means writing that state into
 * one — not holding a "current view" somewhere else that the URL then disagrees with. A linked view
 * and a clicked one land in exactly the same place.
 */
export function viewHref(workspaceSlug: string, view: View): string {
  const params = new URLSearchParams()
  params.set('view_id', view.id)
  if (view.kql) params.set('q', view.kql)
  if (view.layout === 'board') params.set('view', 'board')
  const groupBy = view.display?.groupBy
  if (groupBy && groupBy !== 'none' && groupBy !== 'status') params.set('group', groupBy)
  return `/${workspaceSlug}/tracker?${params.toString()}`
}

/** What a view would be saved as, given what the page is showing right now. */
export function viewStateOf(input: { kql: string; layout: 'list' | 'board'; groupBy: string }): {
  kql: string
  layout: 'list' | 'board'
  display: { groupBy: string }
} {
  return { kql: input.kql, layout: input.layout, display: { groupBy: input.groupBy } }
}
