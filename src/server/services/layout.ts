import type { Tx } from '@kernhq/kernel'
import {
  type FieldDef,
  type FieldLayoutItem,
  PINNED_FIELD_IDS,
  type ResolvedField,
  type ResolvedLayout,
  SYSTEM_LAYOUT_FIELDS,
} from '../../contract/models.js'
import type { ConfigService } from './config.js'
import { toWorkItemType } from './db.js'

/** Fallback labels. An interface translates by `fieldId`; these are what an API caller sees. */
const SYSTEM_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  status: 'Status',
  type: 'Type',
  assignees: 'Assignees',
  priority: 'Priority',
  labels: 'Labels',
  components: 'Components',
  versions: 'Fix versions',
  estimate: 'Estimate',
  startDate: 'Start date',
  dueDate: 'Due date',
  cycle: 'Cycle',
  milestone: 'Milestone',
  parent: 'Parent',
  reporter: 'Reporter',
}

/** The `fieldId` a custom field is addressed by, everywhere: layout, KQL, view columns. */
export const customFieldId = (key: string) => `cf.${key}`

/**
 * Resolves what an issue form should show.
 *
 * Two rules decide everything here, and both exist to keep the feature from looking broken:
 *
 * - **An empty stored layout means the default layout.** Every type starts with `fieldLayout: []`,
 *   so anything else would blank every issue panel in every existing workspace on deploy.
 * - **A field the layout does not mention is appended, not hidden.** An admin who creates a field
 *   and does not immediately lay it out should see it, not conclude the field never saved.
 *
 * Hiding is therefore always explicit — and never possible for a pinned field.
 */
export class LayoutService {
  constructor(private readonly config: ConfigService) {}

  async resolve(
    tx: Tx,
    workspaceId: string,
    projectId: string | null,
    typeId: string,
  ): Promise<ResolvedLayout> {
    const type = toWorkItemType(await this.config.getType(tx, workspaceId, typeId))
    const fields = await this.config.listFields(tx, workspaceId, projectId ? { projectId } : {})
    return build(typeId, projectId, type.fieldLayout, fields)
  }

  /** Same resolution without a round trip, for callers that already hold both. */
  fromParts(
    typeId: string,
    projectId: string | null,
    layout: FieldLayoutItem[],
    fields: FieldDef[],
  ): ResolvedLayout {
    return build(typeId, projectId, layout, fields)
  }
}

/** A resolved field plus the decision about it, before the three lists are split out. */
type Placed = ResolvedField & { placedHidden: boolean }

function build(
  typeId: string,
  projectId: string | null,
  layout: FieldLayoutItem[],
  fields: FieldDef[],
): ResolvedLayout {
  const instructions = new Map<string, FieldLayoutItem>()
  for (const item of layout) instructions.set(item.fieldId, item)

  const placed: Placed[] = []
  let fallbackOrder = 0

  const place = (
    fieldId: string,
    kind: 'system' | 'custom',
    label: string,
    defaultSection: 'main' | 'sidebar',
    def: FieldDef | null,
  ) => {
    const pinned = PINNED_FIELD_IDS.includes(fieldId)
    const item = instructions.get(fieldId)
    // A pinned field ignores an instruction that tries to hide it. The settings editor does not
    // offer the control, but a template written by hand or an older client might carry one.
    const placedHidden = !pinned && (item?.hidden === true || item?.section === 'hidden')
    const section = item?.section === 'main' || item?.section === 'sidebar' ? item.section : defaultSection
    placed.push({
      fieldId,
      kind,
      label,
      section,
      order: item?.order ?? fallbackOrder,
      required: pinned || item?.required === true || def?.required === true,
      pinned,
      showInCards: def?.showInCards ?? false,
      field: def,
      placedHidden,
    })
    fallbackOrder += 1
  }

  for (const sys of SYSTEM_LAYOUT_FIELDS)
    place(sys.id, 'system', SYSTEM_LABELS[sys.id] ?? sys.id, sys.section, null)

  // A field the layout never names appends to the sidebar rather than vanishing.
  for (const field of fields) {
    if (field.archivedAt) continue
    place(customFieldId(field.key), 'custom', field.name, 'sidebar', field)
  }

  const sort = (a: Placed, b: Placed) => a.order - b.order || a.label.localeCompare(b.label)
  const shown = ({ placedHidden: _, ...f }: Placed): ResolvedField => f
  const pick = (want: (f: Placed) => boolean) => placed.filter(want).sort(sort).map(shown)

  return {
    typeId,
    projectId,
    main: pick((f) => !f.placedHidden && f.section === 'main'),
    sidebar: pick((f) => !f.placedHidden && f.section === 'sidebar'),
    hidden: pick((f) => f.placedHidden),
  }
}
