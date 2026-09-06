/**
 * Fail when the published tarball cannot resolve its own imports.
 *
 *   node scripts/check-pack.mjs [package-dir]
 *
 * A module's `./client` entry ships as **source**, not as built output. Nothing in a normal build
 * reads it: `tsc -p tsconfig.json` compiles `src/contract.ts` and `src/server`, `svelte-check`
 * reads the working tree, and both of them see every file in the repository whether the `files`
 * array publishes it or not. So an import that reaches outside the tarball type-checks, lints,
 * tests, builds and publishes, and fails for the first time in a *consumer's* install with
 * "Cannot find module". The archived `KernAIO/modules` monorepo had this check at its root and it
 * caught exactly that twice — `../kql/ast.js` unreachable from the packed tree, and a `./client`
 * export pointing at a file nobody had written. The repository split dropped it, because a check
 * that runs across packages has no home in any one of them; this is that check, per repository,
 * so a new module inherits it by copying the template.
 *
 * What it does:
 *
 *   1. Packs the package for real (`npm pack --dry-run --json`) and takes the file list from npm
 *      rather than re-deriving it from `files` — npm adds README, LICENSE and package.json on its
 *      own and honours `.npmignore`, so a hand-rolled reading of `files` answers a different
 *      question from the one the consumer will ask.
 *   2. Checks every target in the `exports` map is in that list. A target that names a directory
 *      (`./migrations`, mail's `./templates`) is satisfied by any packed file beneath it, and a
 *      wildcard target by any packed file under its static prefix.
 *   3. Walks every relative import reachable from those entry points, transitively, and holds each
 *      resolved file to the packed list.
 *
 * Three ways to make a clean tree report dozens of escapes. The last two were measured doing it,
 * twice each, while the original check was being written:
 *
 *   - **Read the imports with the TypeScript parser, not a regex.** `ts.preProcessFile(text, true,
 *     true)` returns static, re-exported, type-only and dynamic `import()` specifiers, and returns
 *     nothing for the ones inside comments and strings. A regex over raw text has to be told about
 *     each of those forms separately and gets the last one wrong for free: a commented-out example
 *     reads as a missing file. No module has one today (checked 2026-09-06, all nine), so this is
 *     not a bug being fixed — it is a whole class of false alarm that never has to be considered.
 *   - **Resolve each specifier against its own file's directory.** `../contract.js` means
 *     `src/contract.js` from `src/client/index.ts` and `src/client/contract.js` from
 *     `src/client/pages/Foo.svelte`.
 *   - **Map a `.js` specifier onto the `.ts` on disk.** NodeNext imports are written
 *     `../contract.js` against a `files` entry that says `src/contract.ts`. Take the specifier
 *     literally and a clean tree reports dozens of escapes.
 *
 * Run it after `pnpm build`, never in `lint`: the `./contract` and `./server` entries are `dist`
 * files, and an unbuilt tree has none of them. It is in `ci.yml` and again in `publish.yml`,
 * because a red CI run does not stop a publish.
 *
 * Exits 1 naming the importing file, the specifier and where it landed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

const pkgDir = resolve(process.argv[2] ?? '.')
const pkgPath = join(pkgDir, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`check-pack: no package.json in ${pkgDir}`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

/** Paths npm would put in the tarball, relative to the package root, POSIX-separated. */
function packedFiles() {
  let out
  try {
    out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    console.error('check-pack: `npm pack --dry-run --json` failed.')
    console.error(err.stderr?.toString() ?? err.message)
    process.exit(1)
  }
  // npm prints notices on stderr, but be forgiving about anything that reaches stdout ahead of
  // the JSON — a parse failure here would read as a packaging error, which it is not.
  const start = out.indexOf('[')
  if (start === -1) {
    console.error('check-pack: npm pack printed no JSON.')
    process.exit(1)
  }
  const parsed = JSON.parse(out.slice(start))
  return new Set(parsed[0].files.map((f) => f.path.split('\\').join('/')))
}

const packed = packedFiles()
const errors = []

/** Is anything packed under this directory? */
function packedUnder(prefix) {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  for (const f of packed) if (f.startsWith(p)) return true
  return false
}

// ---------------------------------------------------------------------------------------------
// 1. Every `exports` target has to be in the tarball.
// ---------------------------------------------------------------------------------------------

/** Flatten the exports map to [subpath, target] pairs, descending through condition objects. */
function exportTargets(node, subpath, into) {
  if (typeof node === 'string') {
    into.push([subpath, node])
  } else if (Array.isArray(node)) {
    for (const n of node) exportTargets(n, subpath, into)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      exportTargets(value, key.startsWith('.') ? key : subpath, into)
    }
  }
}

const targets = []
exportTargets(pkg.exports ?? {}, '.', targets)

/** Entry files to walk: real files, deduplicated, source or built. */
const entries = new Set()

for (const [subpath, target] of targets) {
  if (!target.startsWith('./')) continue // "node:..." and bare specifiers are not our files
  const rel = target.slice(2)
  if (rel.includes('*')) {
    // A wildcard cannot be checked literally; hold its static prefix to the tarball instead, which
    // is what catches `"./client/*": "./src/client/*"` in a package that stopped shipping src.
    const prefix = rel.slice(0, rel.indexOf('*'))
    if (!packedUnder(prefix) && !packed.has(prefix)) {
      errors.push(`exports["${subpath}"] → ${target}: nothing under "${prefix}" is published.`)
    }
    continue
  }
  if (packed.has(rel)) {
    entries.add(rel)
    continue
  }
  // `./migrations` and mail's `./templates` are directories on purpose.
  if (packedUnder(rel)) continue
  const onDisk = existsSync(join(pkgDir, rel))
  errors.push(
    onDisk
      ? `exports["${subpath}"] → ${target}: exists but the "files" array does not publish it.`
      : `exports["${subpath}"] → ${target}: no such file. Nothing on disk answers this entry.`,
  )
}

// ---------------------------------------------------------------------------------------------
// 2. Every relative import reachable from those entries has to be in the tarball too.
// ---------------------------------------------------------------------------------------------

const WALKABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte)$/

/** The `<script>` bodies of a Svelte component; TypeScript cannot parse the markup around them. */
function svelteScripts(text) {
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
}

function importsOf(absPath) {
  const text = readFileSync(absPath, 'utf8')
  const sources = absPath.endsWith('.svelte') ? svelteScripts(text) : [text]
  const specifiers = []
  for (const source of sources) {
    for (const f of ts.preProcessFile(source, true, true).importedFiles) {
      specifiers.push(f.fileName)
    }
  }
  // One specifier written three times in a file is one problem, not three.
  return [...new Set(specifiers)]
}

/**
 * Candidate on-disk paths for a specifier, in the order Node and the TypeScript resolver would
 * consider them. `.js` first maps onto the `.ts` beside it, because that is how every NodeNext
 * import in these packages is written.
 */
function candidates(rel) {
  const out = []
  const push = (p) => {
    if (!out.includes(p)) out.push(p)
  }
  const m = rel.match(/\.(js|jsx|mjs|cjs)$/)
  if (m) {
    const stem = rel.slice(0, -m[0].length)
    const swap = { js: ['ts', 'tsx', 'd.ts'], jsx: ['tsx'], mjs: ['mts', 'd.mts'], cjs: ['cts'] }
    for (const ext of swap[m[1]]) push(`${stem}.${ext}`)
    push(rel)
  } else if (/\.(ts|tsx|mts|cts|svelte|json|css|svg|md|sql|txt|html)$/.test(rel)) {
    push(rel)
  } else {
    for (const ext of ['ts', 'tsx', 'svelte', 'js', 'mjs', 'jsx', 'd.ts']) push(`${rel}.${ext}`)
  }
  // Extensionless and `.js` specifiers can both name a directory with an index in it.
  const stem = m ? rel.slice(0, -m[0].length) : rel
  for (const ext of ['ts', 'tsx', 'svelte', 'js', 'mjs', 'd.ts']) push(`${stem}/index.${ext}`)
  return out
}

const seen = new Set()
const queue = [...entries]

while (queue.length > 0) {
  const file = queue.pop()
  if (seen.has(file)) continue
  seen.add(file)
  if (!WALKABLE.test(file)) continue

  let specifiers
  try {
    specifiers = importsOf(join(pkgDir, file))
  } catch (err) {
    errors.push(`${file}: could not be read (${err.message}).`)
    continue
  }

  for (const spec of specifiers) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue // a dependency, not our file
    const rel = posix.normalize(posix.join(posix.dirname(file), spec))
    if (rel.startsWith('..')) {
      errors.push(`${file}: "${spec}" leaves the package directory entirely.`)
      continue
    }

    const tried = candidates(rel)
    const inPack = tried.find((c) => packed.has(c))
    if (inPack) {
      queue.push(inPack)
      continue
    }

    // Ask the disk before the directory fallback, not after. `src/client/pages/index.ts` left out
    // of a `files` array that still publishes its siblings is the exact escape this exists to
    // catch, and a `packedUnder` test placed first answers it with "something under there is
    // published" and says nothing.
    const onDisk = tried.find((c) => {
      const abs = join(pkgDir, c)
      return existsSync(abs) && statSync(abs).isFile()
    })
    if (onDisk) {
      errors.push(`${file}: "${spec}" resolves to ${onDisk}, which the "files" array does not publish.`)
      continue
    }

    // No file on disk answers it, so a directory is the remaining legitimate shape.
    if (packedUnder(rel)) continue

    errors.push(`${file}: "${spec}" resolves to no file on disk (tried ${tried.slice(0, 4).join(', ')}).`)
  }
}

// ---------------------------------------------------------------------------------------------

const name = pkg.name ?? relative(process.cwd(), pkgDir)
if (errors.length > 0) {
  console.error(`\n${name}: the published tarball cannot resolve ${errors.length} import(s).\n`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(
    `\nEvery path above has to be inside the tarball. Add the directory to "files" in package.json,` +
      ` or move the file so an already-published directory contains it.\n`,
  )
  process.exit(1)
}

console.log(`${name}: ${packed.size} files packed, ${seen.size} reachable from "exports", all resolvable.`)
