import type { StatusCategory } from '@kernhq/workflow'
import type { Priority } from '../contract/index.js'

/**
 * Presentation rules shared by every tracker surface (list rows, board cards, detail panel).
 *
 * Everything here is pure and framework-free so the same rules can be unit-tested and reused by any
 * host: the Svelte components only turn these values into markup. Colours are design-system tokens
 * (`--kern-*`), never literal hex, so light mode, dark mode and any future theme all work.
 * See `app/DESIGN.md` §3.0 for the drawing spec these values implement.
 */

/** The five status treatments the design draws (DESIGN.md §3.0). */
export type StatusVisual = 'triage' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'

export interface StatusStyle {
  visual: StatusVisual
  /** stroke/fill colour for the status glyph */
  color: string
  /** chip background for the same status */
  tint: string
  /** SVG stroke-dasharray, `null` for a solid ring */
  dash: string | null
  /** inner fill path (16×16 viewBox), `null` for an empty ring */
  fill: string | null
}

const STYLES: Record<StatusVisual, StatusStyle> = {
  triage: {
    visual: 'triage',
    color: 'var(--kern-ink-280)',
    tint: 'var(--kern-surface-chip)',
    dash: '2.2 2',
    fill: null,
  },
  todo: {
    visual: 'todo',
    color: 'var(--kern-ink-350)',
    tint: 'var(--kern-surface-chip)',
    dash: null,
    fill: null,
  },
  in_progress: {
    visual: 'in_progress',
    color: 'var(--kern-accent)',
    tint: 'var(--kern-accent-tint)',
    dash: null,
    fill: 'M8 5.2h2.8v5.6H8z',
  },
  in_review: {
    visual: 'in_review',
    color: 'var(--kern-purple-status)',
    tint: 'var(--kern-purple-tint-2)',
    dash: null,
    fill: 'M8 5.2h2.8v5.6H5.2V8H8z',
  },
  done: {
    visual: 'done',
    color: 'var(--kern-success)',
    tint: 'var(--kern-success-tint-2)',
    dash: null,
    fill: 'M5.2 5.2h5.6v5.6H5.2z',
  },
  cancelled: {
    visual: 'cancelled',
    color: 'var(--kern-ink-330)',
    tint: 'var(--kern-surface-chip)',
    dash: null,
    fill: 'M5.2 5.2h5.6v5.6H5.2z',
  },
}

/** Statuses whose id or name marks them as a review step get the purple treatment. */
const REVIEW = /(^|[-_ ])(review|qa|verify|verification)([-_ ]|$)/i

/**
 * Pick the drawing for a status. The workflow category decides the shape; a status that reads as a
 * review step inside `in_progress` gets its own colour, which is what the design shows.
 */
export function statusStyle(category: StatusCategory, statusId?: string | null, name?: string | null) {
  if (category === 'in_progress' && ((statusId && REVIEW.test(statusId)) || (name && REVIEW.test(name)))) {
    return STYLES.in_review
  }
  switch (category) {
    case 'triage':
      return STYLES.triage
    case 'backlog':
    case 'todo':
      return STYLES.todo
    case 'in_progress':
      return STYLES.in_progress
    case 'done':
      return STYLES.done
    case 'cancelled':
      return STYLES.cancelled
    default:
      return STYLES.todo
  }
}

/** Group ordering for "group by status": triage first, finished work last (DESIGN.md §3.2). */
export const STATUS_CATEGORY_ORDER: Record<StatusCategory, number> = {
  triage: 0,
  backlog: 1,
  todo: 2,
  in_progress: 3,
  done: 4,
  cancelled: 5,
}

/** Highest priority first, matching the design's group order (Urgent, High, Medium, Low). */
export const PRIORITY_GROUP_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

/**
 * The three bars of the priority glyph (DESIGN.md §3.0). `true` = lit.
 * `none` is drawn as an empty box so the column never collapses.
 */
export function priorityBars(priority: Priority): [boolean, boolean, boolean] {
  switch (priority) {
    case 'urgent':
    case 'high':
      return [true, true, true]
    case 'medium':
      return [true, true, false]
    case 'low':
      return [true, false, false]
    default:
      return [false, false, false]
  }
}

/** Geometry of the three bars, shared by the glyph component and any future renderer. */
export const PRIORITY_BAR_GEOMETRY = [
  { x: 1.5, y: 9, height: 5.5 },
  { x: 6.5, y: 5.5, height: 9 },
  { x: 11.5, y: 2, height: 12.5 },
] as const

export type DueTone = 'hot' | 'normal'

/** Today and tomorrow (and anything overdue) are "hot" and drawn in danger red (DESIGN.md §3.0). */
export function dueTone(dueDate: string, today = new Date()): DueTone {
  const days = daysUntil(dueDate, today)
  return days <= 1 ? 'hot' : 'normal'
}

/** Whole days between today (local) and a `YYYY-MM-DD` date; negative when overdue. */
export function daysUntil(dueDate: string, today = new Date()): number {
  const [y, m, d] = dueDate.split('-').map(Number)
  if (!y || !m || !d) return Number.POSITIVE_INFINITY
  const due = Date.UTC(y, m - 1, d)
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((due - start) / 86_400_000)
}

/**
 * Seconds of time as somebody would say it: `45m`, `1h 30m`, `3h`, `1d 2h`.
 *
 * Minutes matter below a day. Rounding to whole hours reported 90 logged minutes as "2h" and a
 * timer running for twenty as "0h" — for an estimate that is a rounding, for time somebody tracked
 * it is wrong, and the same function shows both.
 *
 * Above a day, minutes stop being the point and are dropped.
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0h'
  const totalMinutes = Math.round(seconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`

  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours ? `${days}d ${hours}h` : `${days}d`
}
