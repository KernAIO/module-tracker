import type { RuleRef } from '@kernhq/workflow'

/**
 * A workflow rule, said the way an administrator thinks about it.
 *
 * A transition's conditions, validators and post-functions are stored as `{type, config}`, which is
 * the right thing to store and the wrong thing to show: an editor that renders JSON asks somebody
 * to read a data structure to answer "who is allowed to close this".
 *
 * This lives in the module that owns the rules, so a rule and the sentence describing it cannot
 * drift into different repositories. Every rule type the registry defines has a case; an unknown
 * one — a rule from a newer server, or one an extension added — says its type rather than
 * pretending to know it.
 */

export interface RuleDescription {
  /** the sentence to show */
  text: string
  /** true when nothing here understood the rule, so an interface can mark it as such */
  unknown: boolean
}

type Config = Record<string, unknown>

const str = (config: Config, key: string, fallback = '') => {
  const value = config[key]
  return typeof value === 'string' && value ? value : fallback
}

/** `{kind, id}` subjects, as a list somebody can read. */
function describeSubjects(value: unknown): string {
  if (!Array.isArray(value) || !value.length) return 'nobody'
  return value
    .map((entry) => {
      const subject = (entry ?? {}) as { kind?: string; id?: string }
      switch (subject.kind) {
        case 'assignee':
          return 'the assignee'
        case 'reporter':
          return 'the reporter'
        case 'projectLead':
          return 'the project lead'
        case 'group':
          return 'a group'
        case 'role':
          return subject.id ? `anyone with the ${subject.id} role` : 'a role'
        case 'user':
          return 'a named person'
        case 'field':
          return subject.id ? `whoever is in ${subject.id}` : 'a field'
        default:
          return subject.kind ?? 'somebody'
      }
    })
    .join(', ')
}

export function describeRule(rule: RuleRef): RuleDescription {
  const config = (rule.config ?? {}) as Config
  const known = (text: string): RuleDescription => ({ text, unknown: false })

  switch (rule.type) {
    // conditions — who may do it, and when
    case 'user.hasPermission':
      return known(`Only somebody with “${str(config, 'permission', 'a permission')}”`)
    case 'user.isAssignee':
      return known('Only the assignee')
    case 'user.isReporter':
      return known('Only the reporter')
    case 'user.inGroup':
      return known('Only members of a particular group')
    case 'field.equals':
      return known(`Only when ${str(config, 'field', 'a field')} is “${String(config.value ?? '')}”`)
    case 'field.notEmpty':
      return known(`Only when ${str(config, 'field', 'a field')} has a value`)
    case 'subtasks.allDone':
      return known('Only when every sub-issue is done')

    // validators — what has to be filled in first
    case 'field.required':
      return known(`${str(config, 'field', 'A field')} must be filled in`)
    case 'comment.required':
      return known('A comment is required')
    case 'estimate.required':
      return known('An estimate is required')

    // post-functions — what happens afterwards
    case 'field.set':
      return known(`Sets ${str(config, 'field', 'a field')} to “${String(config.value ?? '')}”`)
    case 'assign.to': {
      const to = str(config, 'to')
      const who =
        to === 'currentUser'
          ? 'whoever moved it'
          : to === 'reporter'
            ? 'the reporter'
            : to === 'unassigned'
              ? 'nobody'
              : 'a named person'
      return known(`Assigns it to ${who}`)
    }
    case 'resolution.set': {
      const value = config.value
      return known(value === null ? 'Clears the resolution' : `Sets the resolution to “${String(value)}”`)
    }
    case 'notify':
      return known(`Notifies ${describeSubjects(config.subjects)}`)
    case 'webhook':
      return known(`Calls ${str(config, 'url', 'a webhook')}`)
    case 'subitem.create':
      return known(`Creates a sub-issue called “${str(config, 'title', 'something')}”`)
    case 'run.automation':
      return known('Runs an automation')

    default:
      // Naming the type is more use than a guess: somebody can search for it.
      return { text: rule.type, unknown: true }
  }
}

/** Who may approve, for a transition that needs sign-off. */
export function describeApprovers(subjects: unknown, minApprovals: number): string {
  const who = describeSubjects(subjects)
  return minApprovals > 1 ? `${minApprovals} approvals from ${who}` : `Approval from ${who}`
}
