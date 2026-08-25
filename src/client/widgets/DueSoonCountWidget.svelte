<script lang="ts">
import type { WidgetProps } from '@kernhq/ui'
import { t } from '../i18n.js'
import CountWidget from './CountWidget.svelte'

let { workspaceId, workspaceSlug }: WidgetProps = $props()
</script>

<CountWidget
  label={t('widget_due_soon_title')}
  kql="assignee = currentUser() and due <= 7d and statusCategory in (todo, in_progress)"
  {workspaceId}
  href="/{workspaceSlug}/tracker?preset=assigned"
/>
