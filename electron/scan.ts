import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { CodeMap, FileEntry, FolderEntry, FunctionEntry } from '../shared/types'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  'public',
  'vendor',
  '.next',
  '.architect',
  '.claude',
])

const YIELD_EVERY = 50

const SCRIPT_KINDS = new Map<string, ts.ScriptKind>([
  ['.ts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JSX],
  ['.jsx', ts.ScriptKind.JSX],
  ['.mjs', ts.ScriptKind.JSX],
  ['.cjs', ts.ScriptKind.JSX],
])

function propertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const inner = name.expression
    if (ts.isStringLiteral(inner) || ts.isNumericLiteral(inner)) return inner.text
    return undefined
  }
  return undefined
}

function isFunctionValue(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

function declaredName(node: ts.Node, owner: string): string | undefined {
  const prefix = owner ? `${owner}.` : ''

  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? 'default'
  if (ts.isConstructorDeclaration(node)) return `${owner || 'default'}.constructor`

  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = propertyName(node.name)
    return name === undefined ? undefined : prefix + name
  }

  if (ts.isPropertyDeclaration(node) && isFunctionValue(node.initializer)) {
    const name = propertyName(node.name)
    return name === undefined ? undefined : prefix + name
  }

  if (ts.isPropertyAssignment(node) && isFunctionValue(node.initializer)) {
    const name = propertyName(node.name)
    return name === undefined ? undefined : prefix + name
  }

  if (ts.isVariableDeclaration(node) && isFunctionValue(node.initializer)) {
    const name = propertyName(node.name)
    return name === undefined ? undefined : name
  }

  if (ts.isExportAssignment(node) && isFunctionValue(node.expression)) return 'default'

  return undefined
}

function ownerFor(node: ts.Node, owner: string): string {
  if (ts.isClassLike(node)) return node.name?.text ?? owner
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isObjectLiteralExpression(node)) return owner

  if (ts.isPropertyAssignment(node)) {
    const name = propertyName(node.name)
    if (name === undefined) return ''
    return owner ? `${owner}.${name}` : name
  }

  return ''
}

function calleeName(expression: ts.Expression, self: string): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return self === '' ? undefined : self
  if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression, self)

  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    const base = calleeName(expression.expression, self)
    return base === undefined ? undefined : `${base}.${expression.name.text}`
  }

  return undefined
}

type Found = { entry: FunctionEntry; node: ts.Node; owner: string }

function scopeOf(node: ts.Node): ts.Node | undefined {
  let at: ts.Node | undefined = node.parent
  while (at !== undefined && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent
  return at
}

function isOverloadSignature(node: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
    node.body === undefined
  )
}

function importedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) names.add(statement.name.text)
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue

    const clause = statement.importClause
    if (clause.name) names.add(clause.name.text)

    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text)
  }

  return names
}

function boundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) return void into.add(name.text)
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) boundNames(element.name, into)
  }
}

function shadowsOf(source: ts.SourceFile): Map<ts.Node, Set<string>> {
  const byScope = new Map<ts.Node, Set<string>>()

  const at = (node: ts.Node): Set<string> | undefined => {
    const scope = ts.isParameter(node) ? node.parent : scopeOf(node)
    if (scope === undefined) return undefined
    const names = byScope.get(scope) ?? new Set<string>()
    byScope.set(scope, names)
    return names
  }

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) boundNames(node.name, at(node) ?? new Set())
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      boundNames(node.variableDeclaration.name, at(node.variableDeclaration) ?? new Set())
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return byScope
}

function bindingsOf(found: Found[]): Map<ts.Node, Map<string, number>> {
  const byScope = new Map<ts.Node, Map<string, number>>()

  for (const [i, f] of found.entries()) {
    const scope = scopeOf(f.node)
    if (scope === undefined) continue

    const names = byScope.get(scope) ?? new Map<string, number>()
    byScope.set(scope, names)

    const prev = names.get(f.entry.name)
    const previous = prev === undefined ? undefined : found[prev]
    if (previous === undefined || !isOverloadSignature(f.node) || isOverloadSignature(previous.node)) {
      names.set(f.entry.name, i)
    }
  }

  return byScope
}

function resolveCall(
  name: string,
  at: ts.Node,
  byScope: Map<ts.Node, Map<string, number>>,
  shadows: Map<ts.Node, Set<string>>,
  imported: Set<string>,
): number | undefined {
  const root = name.split('.')[0] ?? name

  for (let scope = scopeOf(at); scope !== undefined; scope = scopeOf(scope)) {
    const hit = byScope.get(scope)?.get(name)
    if (hit !== undefined) return hit
    if (shadows.get(scope)?.has(root)) return undefined
    if (ts.isSourceFile(scope) && imported.has(root)) return undefined
  }

  return undefined
}

function callsIn(
  node: ts.Node,
  self: string,
  nested: Set<ts.Node>,
  resolve: (name: string, at: ts.Node) => number | undefined,
): number[] {
  const found = new Set<number>()

  const visit = (child: ts.Node): void => {
    if (child !== node && nested.has(child)) return

    if (ts.isCallExpression(child)) {
      const name = calleeName(child.expression, self)
      const target = name === undefined ? undefined : resolve(name, child)
      if (target !== undefined) found.add(target)
    }

    ts.forEachChild(child, visit)
  }

  visit(node)
  return [...found]
}

function functionsIn(source: string, file: string): FunctionEntry[] {
  const lower = file.toLowerCase()
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return []

  const kind = SCRIPT_KINDS.get(path.extname(lower))
  if (kind === undefined) return []

  try {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
    const found: Found[] = []

    const visit = (node: ts.Node, owner: string): void => {
      const name = declaredName(node, owner)
      if (name !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
        found.push({ entry: { name, line, endLine, description: '', calls: [] }, node, owner })
      }

      const next = ownerFor(node, owner)
      ts.forEachChild(node, (child) => visit(child, next))
    }

    ts.forEachChild(sourceFile, (child) => visit(child, ''))

    const nested = new Set(found.map((f) => f.node))
    const byScope = bindingsOf(found)
    const shadows = shadowsOf(sourceFile)
    const imported = importedNames(sourceFile)
    const calls = found.map((f) =>
      callsIn(f.node, f.owner, nested, (name, at) => resolveCall(name, at, byScope, shadows, imported)),
    )

    const order = found
      .map((f, i) => ({ f, i }))
      .sort((a, b) => a.f.entry.line - b.f.entry.line || a.f.entry.name.localeCompare(b.f.entry.name))
    const rank = new Map(order.map(({ i }, to) => [i, to]))

    return order.map(({ f, i }) => ({
      ...f.entry,
      calls: (calls[i] ?? []).flatMap((c) => (rank.has(c) ? [rank.get(c) as number] : [])).sort((a, b) => a - b),
    }))
  } catch {
    return []
  }
}

function readText(file: string): string | undefined {
  try {
    const buffer = fs.readFileSync(file)
    if (buffer.subarray(0, 8192).includes(0)) return undefined
    return buffer.toString('utf8')
  } catch {
    return undefined
  }
}

function yieldToLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function walk(root: string, relative: string, into: FolderEntry[], counter: { seen: number }): Promise<void> {
  const absolute = relative ? path.join(root, relative) : root

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true })
  } catch {
    entries = []
  }

  const folders: string[] = []
  const files: FileEntry[] = []

  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      folders.push(child)
      await walk(root, child, into, counter)
      continue
    }

    if (!entry.isFile()) continue

    counter.seen += 1
    if (counter.seen % YIELD_EVERY === 0) await yieldToLoop()

    const source = readText(path.join(absolute, entry.name))
    if (source === undefined) continue

    files.push({ path: child, functions: functionsIn(source, entry.name) })
  }

  folders.sort((a, b) => a.localeCompare(b))
  files.sort((a, b) => a.path.localeCompare(b.path))

  into.push({ path: relative, folders, files })
}

export async function scan(root: string): Promise<CodeMap> {
  const folders: FolderEntry[] = []
  await walk(root, '', folders, { seen: 0 })
  folders.sort((a, b) => a.path.localeCompare(b.path))

  return { root, scannedAt: Date.now(), folders }
}
