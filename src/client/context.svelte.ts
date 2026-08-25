import { getContext, setContext } from 'svelte'
import type {
  Component,
  Cycle,
  FieldDef,
  Label,
  Milestone,
  Project,
  StatusInfo,
  WorkItemType,
} from './index.js'

export interface Person {
  id: string
  name: string
  avatarUrl: string | null
}

/**
 * The reference data every tracker view needs to turn ids into something a person can read.
 *
 * Issues carry ids, not names: a row has a `projectId`, a `statusId` and `assigneeIds`. Rather than
 * threading six lists through every component, the page loads them once and publishes them here, and
 * the rows, cards and detail panel look up what they need. Kept in runes so a refetch (or a realtime
 * change) redraws the views that read it.
 */
export class TrackerCatalogue {
  projects = $state<Project[]>([])
  statuses = $state<StatusInfo[]>([])
  types = $state<WorkItemType[]>([])
  labels = $state<Label[]>([])
  cycles = $state<Cycle[]>([])
  milestones = $state<Milestone[]>([])
  components = $state<Component[]>([])
  people = $state<Person[]>([])
  /** The workspace's custom fields, so cards and group headings can read a value's label. */
  fields = $state<FieldDef[]>([])

  #projects = $derived(new Map(this.projects.map((p) => [p.id, p])))
  #statuses = $derived(new Map(this.statuses.map((s) => [s.id, s])))
  #types = $derived(new Map(this.types.map((t) => [t.id, t])))
  #labels = $derived(new Map(this.labels.map((l) => [l.id, l])))
  #cycles = $derived(new Map(this.cycles.map((c) => [c.id, c])))
  #milestones = $derived(new Map(this.milestones.map((ms) => [ms.id, ms])))
  #components = $derived(new Map(this.components.map((c) => [c.id, c])))
  #people = $derived(new Map(this.people.map((p) => [p.id, p])))
  #fields = $derived(new Map(this.fields.map((f) => [f.key, f])))

  project = (id: string | null | undefined) => (id ? this.#projects.get(id) : undefined)
  status = (id: string | null | undefined) => (id ? this.#statuses.get(id) : undefined)
  type = (id: string | null | undefined) => (id ? this.#types.get(id) : undefined)
  label = (id: string | null | undefined) => (id ? this.#labels.get(id) : undefined)
  cycle = (id: string | null | undefined) => (id ? this.#cycles.get(id) : undefined)
  milestone = (id: string | null | undefined) => (id ? this.#milestones.get(id) : undefined)
  component = (id: string | null | undefined) => (id ? this.#components.get(id) : undefined)
  person = (id: string | null | undefined) => (id ? this.#people.get(id) : undefined)
  field = (key: string | null | undefined) => (key ? this.#fields.get(key) : undefined)

  /**
   * What a value of a custom field is called.
   *
   * A `select` stores an option id, so a group heading that showed the raw value would read
   * `opt_7f3a` instead of `Sev 1`.
   */
  customValueLabel = (fieldKey: string, value: string): string => {
    const field = this.#fields.get(fieldKey)
    if (!field) return value
    const option = field.options.find((o) => o.id === value)
    if (option) return option.label
    if (field.type === 'user' || field.type === 'multiuser') return this.person(value)?.name ?? value
    return value
  }

  /**
   * What a sum of estimates is said in.
   *
   * Per-issue the unit comes off the issue, but a group heading adds several up: they can only be
   * added at all when the projects in view agree, and where they do not, points is what a mixed sum
   * already meant.
   */
  estimateUnit = $derived.by<'points' | 'hours' | 'none'>(() => {
    const units = new Set(this.projects.map((p) => p.settings.estimation))
    const only = units.size === 1 ? [...units][0] : null
    return only === 'hours' ? 'hours' : 'points'
  })

  /** The active cycle drives the sprint progress bar in the header. */
  activeCycle = $derived(this.cycles.find((c) => c.status === 'active') ?? null)

  /** Workflow order of a status, used to sort list groups and board columns. */
  statusOrder = (id: string) => this.status(id)?.order ?? 99
  statusCategory = (id: string) => this.status(id)?.category ?? 'todo'
}

const KEY = Symbol('tracker.catalogue')

export function setTrackerCatalogue(catalogue: TrackerCatalogue): TrackerCatalogue {
  return setContext(KEY, catalogue)
}

export function getTrackerCatalogue(): TrackerCatalogue {
  const catalogue = getContext<TrackerCatalogue | undefined>(KEY)
  if (!catalogue) throw new Error('Tracker components must be rendered inside the tracker page')
  return catalogue
}
