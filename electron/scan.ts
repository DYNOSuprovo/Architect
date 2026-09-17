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

function functionsIn(source: string, file: string): FunctionEntry[] {
  const lower = file.toLowerCase()
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return []

  const kind = SCRIPT_KINDS.get(path.extname(lower))
  if (kind === undefined) return []

  const found: FunctionEntry[] = []

  try {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)

    const visit = (node: ts.Node, owner: string): void => {
      const name = declaredName(node, owner)
      if (name !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        found.push({ name, line, description: '' })
      }

      const next = ownerFor(node, owner)
      ts.forEachChild(node, (child) => visit(child, next))
    }

    ts.forEachChild(sourceFile, (child) => visit(child, ''))
  } catch {
    return []
  }

  return found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
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
