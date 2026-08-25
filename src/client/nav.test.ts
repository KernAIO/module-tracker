import { describe, expect, it } from 'vitest'
import {
  isProjectSection,
  isTrackerTarget,
  projectKql,
  projectSectionHref,
  projectTargets,
  trackerHref,
} from './nav.js'

const PROJECT = '01920000-0000-7000-8000-0000000000a1'

describe('tracker sidebar links', () => {
  it('quotes a project id, because KQL would read a bare uuid as a number', () => {
    expect(projectKql(PROJECT)).toBe(`project = "${PROJECT}"`)
  })

  it('asks for nothing it does not need', () => {
    expect(trackerHref('northstar')).toBe('/northstar/tracker')
    expect(trackerHref('northstar', { preset: 'assigned' })).toBe('/northstar/tracker?preset=assigned')
  })

  it('carries the query and the grouping a project view stands for', () => {
    const href = trackerHref('northstar', projectTargets(PROJECT).byComponent)
    const params = new URL(href, 'https://example.test').searchParams
    expect(params.get('q')).toBe(projectKql(PROJECT))
    expect(params.get('group')).toBe('component')
  })

  it('marks a row current only when the screen shows exactly what it asks for', () => {
    const at = (search: string) => new URL(`https://example.test/x${search}`).searchParams
    const components = projectTargets(PROJECT).byComponent

    expect(isTrackerTarget(at(''), {})).toBe(true)
    expect(isTrackerTarget(at('?preset=assigned'), { preset: 'assigned' })).toBe(true)
    // the same query grouped differently is a different row
    expect(isTrackerTarget(at(`?q=${encodeURIComponent(components.q!)}`), components)).toBe(false)
    expect(isTrackerTarget(at(`?q=${encodeURIComponent(components.q!)}&group=component`), components)).toBe(
      true,
    )
    // "All issues" must not light up while a filtered list is on screen
    expect(isTrackerTarget(at('?preset=assigned'), {})).toBe(false)
  })

  it('addresses a project page by the key people know it by', () => {
    expect(projectSectionHref('northstar', 'KRN', 'milestones')).toBe(
      '/northstar/tracker/projects/KRN/milestones',
    )
    // an unknown section in the URL must not render a blank page
    expect(isProjectSection('components')).toBe(true)
    expect(isProjectSection('nonsense')).toBe(false)
    expect(isProjectSection(undefined)).toBe(false)
  })

  it('gives no row to a saved view, which has one of its own', () => {
    const params = new URL('https://example.test/x?view_id=v1').searchParams
    expect(isTrackerTarget(params, {})).toBe(false)
  })
})
