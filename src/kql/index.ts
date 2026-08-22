/**
 * KQL — Kern Query Language.
 *
 * A JQL-like query language over tracker issues: `assignee = currentUser() and status != done
 * order by priority desc`. This entry point is isomorphic (no database, no Node built-ins) so the
 * app can parse, validate and autocomplete a query while the user types; the SQL compiler that turns
 * a parsed query into a statement lives server-side in `@kernhq/module-tracker/server`.
 */
export * from './ast.js'
export * from './dates.js'
export * from './fields.js'
export { type LexError, type LexResult, type Token, type TokenKind, tokenize } from './lexer.js'
export { type ParseError, type ParseResult, parseKql } from './parser.js'
export { suggest } from './suggest.js'
export { type KqlIssue, validateQuery } from './validate.js'
