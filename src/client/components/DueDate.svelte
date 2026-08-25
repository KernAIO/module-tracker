<script lang="ts">
import { messageLocale } from '@kernhq/ui'
import { t } from '../i18n.js'
import { daysUntil, dueTone } from '../index.js'

/**
 * A due date as the list and the board show it (DESIGN.md 3.0): anything due today, tomorrow or
 * already late is drawn in danger red, everything else stays quiet.
 */
interface Props {
  date: string
  class?: string
}
let { date, class: className = '' }: Props = $props()

const days = $derived(daysUntil(date))
const tone = $derived(dueTone(date))
const text = $derived.by(() => {
  if (days === 0) return t('due_today')
  if (days === 1) return t('due_tomorrow')
  const [y, mo, d] = date.split('-').map(Number)
  const local = new Date(y ?? 1970, (mo ?? 1) - 1, d ?? 1)
  const opts: Intl.DateTimeFormatOptions =
    local.getFullYear() === new Date().getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }
  return new Intl.DateTimeFormat(messageLocale(), opts).format(local)
})
</script>

<time datetime={date} class="kdue {tone} {className}" title={days < 0 ? t('due_overdue') : undefined}>
  {text}
</time>

<style>
  .kdue {
    font-size: 12.5px;
    white-space: nowrap;
    color: var(--kern-ink-350);
  }
  .kdue.hot {
    color: var(--kern-danger);
  }
</style>
