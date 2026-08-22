import { KernError } from '@kernhq/kernel'
import type { FieldDef } from '../../contract/models.js'

/** Why a value was rejected, in terms the interface can put next to the field. */
export interface ValueProblem {
  /** the layout/KQL field id, e.g. `cf.severity` */
  fieldId: string
  message: string
}

/**
 * A source that is allowed to produce an incomplete issue.
 *
 * A customer replying to a support address does not know the workspace made "Impact" required. If
 * required fields were enforced on that path, the mail would bounce and the request would be lost —
 * so inbound sources record the gap and carry on, and a human completes the issue afterwards.
 */
const LENIENT_SOURCES: ReadonlySet<string> = new Set(['email', 'intake', 'import', 'automation'])

const isBlank = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v])

/**
 * Validates one value against its field definition. Pure: every lookup it needs is passed in, so
 * it can be unit-tested and called in a loop without touching the database.
 */
export function checkValue(
  def: FieldDef,
  value: unknown,
  ctx: { optionIds?: Set<string>; memberIds?: Set<string> } = {},
): string | null {
  if (isBlank(value)) return null
  const cfg = def.config ?? {}

  switch (def.type) {
    case 'number':
    case 'formula': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Expected a number'
      if (cfg.min !== undefined && value < cfg.min) return `Must be at least ${cfg.min}`
      if (cfg.max !== undefined && value > cfg.max) return `Must be at most ${cfg.max}`
      if (cfg.precision !== undefined) {
        const scaled = value * 10 ** cfg.precision
        if (Math.abs(scaled - Math.round(scaled)) > 1e-9)
          return cfg.precision === 0
            ? 'Must be a whole number'
            : `Must have at most ${cfg.precision} decimal places`
      }
      return null
    }
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return 'Expected text'
      if (cfg.maxLength !== undefined && value.length > cfg.maxLength)
        return `Must be ${cfg.maxLength} characters or fewer`
      if (cfg.pattern) {
        // The pattern is validated when the field is saved, so a bad one cannot reach here. If one
        // somehow does, refuse the value rather than throwing an unhandled SyntaxError on a write.
        try {
          if (!new RegExp(cfg.pattern).test(value)) return 'Does not match the required format'
        } catch {
          return 'The field has an invalid pattern — ask an administrator to correct it'
        }
      }
      return null
    }
    case 'date':
    case 'datetime': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return 'Expected a date in ISO format'
      return null
    }
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'Expected true or false'
    case 'url': {
      if (typeof value !== 'string') return 'Expected a URL'
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        return 'Expected a valid URL'
      }
      // Anything else — `javascript:`, `data:` — becomes a click target in the interface.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return 'Only http and https links are allowed'
      return null
    }
    case 'select':
    case 'multiselect':
    case 'label': {
      const values = def.type === 'select' ? [value] : asArray(value)
      const allowed = ctx.optionIds ?? new Set(def.options.filter((o) => !o.archived).map((o) => o.id))
      for (const v of values) {
        if (typeof v !== 'string') return 'Expected an option id'
        if (!allowed.has(v)) return 'Not one of the available options'
      }
      return null
    }
    case 'user':
    case 'multiuser': {
      const values = def.type === 'user' ? [value] : asArray(value)
      for (const v of values) {
        if (typeof v !== 'string') return 'Expected a user id'
        if (ctx.memberIds && !ctx.memberIds.has(v)) return 'Not a member of this workspace'
      }
      return null
    }
    case 'relation': {
      // Always an array, whatever `relationMultiple` says — see the KQL compiler, which relies on it.
      const values = asArray(value)
      if (cfg.relationMultiple === false && values.length > 1) return 'Only one item may be linked'
      for (const v of values) if (typeof v !== 'string') return 'Expected an issue id'
      return null
    }
    default:
      return null
  }
}

/**
 * Turns a submitted `custom` patch into the object to store.
 *
 * On create it starts empty and applies defaults; on update it merges into what is already there,
 * where an explicit `null` deletes a key. Unknown keys are refused either way — silently dropping
 * one makes a typo look like a field that does not save.
 */
export async function normaliseCustom(args: {
  fields: FieldDef[]
  current: Record<string, unknown> | null
  patch: Record<string, unknown> | undefined
  mode: 'create' | 'update'
  source: string
  /** resolves the workspace members a `user` field may name; omitted or undefined → not checked */
  memberIds?: () => Promise<Set<string> | undefined>
  /** required fields to enforce, as `cf.<key>`; omitted → the field definitions' own `required` */
  requiredFieldIds?: Set<string>
}): Promise<{ custom: Record<string, unknown>; skipped: ValueProblem[] }> {
  const byKey = new Map(args.fields.map((f) => [f.key, f]))
  const out: Record<string, unknown> = args.mode === 'create' ? {} : { ...(args.current ?? {}) }
  const problems: ValueProblem[] = []
  let members: Set<string> | undefined
  let membersLoaded = false

  for (const [key, value] of Object.entries(args.patch ?? {})) {
    const def = byKey.get(key)
    if (!def) throw KernError.badRequest(`Unknown custom field "${key}"`, { field: `cf.${key}` })
    if (value === null) {
      delete out[key]
      continue
    }
    if ((def.type === 'user' || def.type === 'multiuser') && args.memberIds && !membersLoaded) {
      members = await args.memberIds()
      membersLoaded = true
    }
    const problem = checkValue(def, value, { memberIds: members })
    if (problem) throw KernError.badRequest(problem, { field: `cf.${key}` })
    out[key] = value
  }

  if (args.mode === 'create')
    for (const def of args.fields)
      if (out[def.key] === undefined && def.defaultValue != null) out[def.key] = def.defaultValue

  const lenient = LENIENT_SOURCES.has(args.source)
  // On update, judge only the fields this patch touched. An issue created leniently — a customer
  // email with no "Impact" — can still be edited; what cannot happen is *clearing* a required
  // field, which touches it and so is caught.
  const touched = new Set(Object.keys(args.patch ?? {}))
  for (const def of args.fields) {
    const fieldId = `cf.${def.key}`
    if (args.mode === 'update' && !touched.has(def.key)) continue
    const required = args.requiredFieldIds ? args.requiredFieldIds.has(fieldId) : def.required
    if (!required || !isBlank(out[def.key])) continue
    const message = `"${def.name}" is required`
    if (lenient) problems.push({ fieldId, message })
    else throw KernError.badRequest(message, { field: fieldId })
  }

  return { custom: out, skipped: problems }
}
