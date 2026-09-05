<script lang="ts">
import { Button, formatCount, StatTile } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'

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
  <!-- A failed count is not a count of nothing: `data ?? 0` used to render a confident "0" on a
       dashboard for a query that never came back. -->
  {#if query.isError}
    <div class="failed">
      <p>{t('common.error')}</p>
      <Button size="xs" variant="ghost" onclick={() => void query.refetch()}>{t('common.retry')}</Button>
    </div>
  {:else}
    <StatTile
      {label}
      value={query.isPending ? '—' : formatCount(query.data?.total ?? 0)}
      {href}
      size="md"
      class="tile"
    />
  {/if}
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
  .failed {
    display: grid;
    justify-items: start;
    gap: 6px;
    font-size: 12.5px;
    color: var(--kern-ink-600);
  }
  .failed p {
    margin: 0;
  }
</style>
