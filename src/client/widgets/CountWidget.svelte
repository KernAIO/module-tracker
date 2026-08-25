<script lang="ts">
import { formatCount, StatTile } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'

/**
 * One number from one KQL query.
 *
 * `include.total` is a real count from the server, not `items.length` — a tile that counted the page
 * it happened to fetch would say "20" for ever.
 */
interface Props {
  label: string
  kql: string
  workspaceId: string
  href?: string
}
let { label, kql, workspaceId, href }: Props = $props()

const api = getTrackerApi()
const query = createQuery(() => ({
  queryKey: ['tracker', 'issue', workspaceId, 'count', kql],
  queryFn: () =>
    api.issues.query({
      workspaceId,
      kql,
      limit: 1,
      include: { total: true, groupCounts: false, full: false },
    }),
  enabled: Boolean(workspaceId),
}))
</script>

<div class="wrap">
  <StatTile
    {label}
    value={query.isPending ? '—' : formatCount(query.data?.total ?? 0)}
    {href}
    size="md"
    class="tile"
  />
</div>

<style>
  .wrap {
    display: grid;
    align-content: center;
    height: 100%;
    padding: 14px 16px;
  }
  .wrap :global(.tile) {
    border: 0;
    background: transparent;
    padding: 0;
  }
</style>
