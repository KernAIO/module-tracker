<script lang="ts">
import { type StatusCategory, statusStyle } from '../index.js'

/**
 * The status glyph (DESIGN.md 3.0): a rounded square whose ring colour comes from the workflow
 * category and whose inner block fills as work moves along. Triage is dashed, Done is solid.
 */
interface Props {
  category: StatusCategory
  /** status id and name refine the category, so "In review" gets its own colour */
  statusId?: string | null
  name?: string | null
  size?: number
  /** set to expose the status to assistive technology; otherwise the icon is decorative */
  label?: string | null
}
let { category, statusId = null, name = null, size = 16, label = null }: Props = $props()
const style = $derived(statusStyle(category, statusId, name))
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  class="ksi"
  role={label ? 'img' : 'presentation'}
  aria-label={label ?? undefined}
  aria-hidden={label ? undefined : 'true'}
>
  <rect
    x="1.7"
    y="1.7"
    width="12.6"
    height="12.6"
    rx="4"
    fill="none"
    stroke={style.color}
    stroke-width="1.5"
    stroke-dasharray={style.dash ?? undefined}
  />
  {#if style.fill}<path d={style.fill} fill={style.color} />{/if}
</svg>

<style>
  .ksi {
    flex: none;
    display: block;
  }
</style>
