import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { issueUrl, projectUrl } from './services/db.js'

/**
 * A link the server emits has to resolve to a screen the client declares.
 *
 * `issueUrl` returned `/tracker/issues/<key>` and the tracker's client module has never declared a
 * route under `/tracker/issues`. Nothing errored: shell's `resolveModuleRoute` matches a
 * declaration *shorter* than the URL as a prefix, so the address fell back to `/tracker` and
 * rendered the issue list — so every tracker notification and every tracker search hit opened the
 * list rather than the issue it named, and looked like it had worked.
 *
 * The two halves live in different files and neither compiles against the other, which is why this
 * reads the declarations out of the client module rather than restating them. Parsing the source is
 * the price of the client entry being Svelte: importing it needs the Svelte plugin, which this
 * suite does not run.
 */

const CLIENT_MODULE = join(dirname(fileURLToPath(import.meta.url)), '../client/module.ts')

/** Every `path:` a `routes:` entry declares, e.g. `/tracker`, `/tracker/projects/:key`. */
function declaredRoutePaths(): string[] {
  const source = readFileSync(CLIENT_MODULE, 'utf8')
  return [...source.matchAll(/^\s*path: '([^']+)',$/gm)].map((m) => m[1]!)
}

/** How shell's `resolveModuleRoute` matches: a declaration may be a prefix, `:name` takes one segment. */
function matches(declaration: string, segments: string[]): boolean {
  const parts = declaration.split('/').filter(Boolean)
  if (segments.length < parts.length) return false
  return parts.every((part, i) => (part.startsWith(':') ? Boolean(segments[i]) : segments[i] === part))
}

/** The declaration shell would pick: most literal segments first, then length. */
function resolves(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean)
  let best: string | undefined
  let bestScore = -1
  for (const declaration of declaredRoutePaths()) {
    if (!matches(declaration, segments)) continue
    const parts = declaration.split('/').filter(Boolean)
    const score = parts.filter((p) => !p.startsWith(':')).length * 1000 + parts.length
    if (score > bestScore) {
      bestScore = score
      best = declaration
    }
  }
  return best
}

describe('the URLs notifications and search hits carry', () => {
  it('reads a non-empty set of route declarations, so the assertions below are not vacuous', () => {
    // A regex that matches nothing looks exactly like a module whose every URL is correct.
    expect(declaredRoutePaths()).toContain('/tracker')
  })

  it('sends an issue to the screen that can open it', () => {
    const url = new URL(issueUrl('KRN-12'), 'https://example.test/workspace')
    // `IssuesPage` reads `params.get('issue')` and hands it to `issues.getByKey`, so the parameter
    // carries the key rather than the id.
    expect(url.searchParams.get('issue')).toBe('KRN-12')
    expect(resolves(url.pathname), 'no client route claims this path').toBe('/tracker')
  })

  it('escapes a key rather than letting it change the query', () => {
    const url = new URL(issueUrl('KRN-1&issue=OTHER-9'), 'https://example.test/workspace')
    expect(url.searchParams.getAll('issue')).toEqual(['KRN-1&issue=OTHER-9'])
  })

  it('sends a project to its own page, which is a declared path', () => {
    expect(resolves(projectUrl('KRN'))).toBe('/tracker/projects/:key')
  })
})
