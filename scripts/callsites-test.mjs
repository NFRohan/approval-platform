// =====================================================================
// Call-site test.
//
//   npm run test:callsites
//
// Every screen reaches the database through a whitelist that decides
// which tables, columns and functions exist, and which of them may be
// written. Nothing checked that the screens agreed with it. They did
// not: thirteen writes set a column the whitelist refuses, the form
// builder sent an id it would not accept, and a stock function was
// called with argument names it does not declare, so both venues
// arrived as null. All of it compiled, all of it rendered, and every
// suite stayed green — because the disagreement only surfaces when a
// person clicks something.
//
// So this reads every `db.from(...)` chain and every `db.rpc(...)` call
// out of the syntax tree and pushes it through the real query builder.
// A chain that cannot produce SQL is a screen that cannot save.
//
// Static: no database, no browser, no rendering.
// =====================================================================

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createServer } from 'vite';
import ts from 'typescript';

// The builder and the whitelist are the things under test, loaded the
// way the server loads them rather than reimplemented here.
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
});
const { build } = await vite.ssrLoadModule('/src/server/query.ts');
const { RPCS } = await vite.ssrLoadModule('/src/server/tables.ts');

// ---------------------------------------------------------------------
// Which files hold call sites
// ---------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const SKIP = [
  `src${sep}server${sep}`,
  join('src', 'lib', 'db.ts'),
  join('src', 'lib', 'data-fn.ts'),
];
const files = walk('src').filter((f) => !SKIP.some((s) => f.includes(s)));

// ---------------------------------------------------------------------
// Reading a chain out of the tree
// ---------------------------------------------------------------------
const literal = (n) =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

/** Keys of an object literal, including shorthand. Spreads are unknowable. */
function objectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  const keys = [];
  let spread = false;
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) { spread = true; continue; }
    const name = prop.name;
    if (!name) continue;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.push(name.text);
  }
  return { keys, spread };
}

/** The enclosing function, so a variable lookup cannot cross scopes. */
function enclosingFunction(node) {
  let n = node;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n)
        || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return n;
    n = n.parent;
  }
  return null;
}

/** The initialiser of `const <name> = ...` in the enclosing function. */
function localInitialiser(callNode, name) {
  const fn = enclosingFunction(callNode);
  if (!fn) return null;
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
        && n.name.text === name && n.initializer) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

/**
 * The columns a write sends.
 *
 * Only ever the *top level* of a row object. Descending into nested
 * values would read `field_config: { helper: ... }` as a column called
 * helper, which is a column the whitelist rightly refuses — the reader
 * would be reporting its own mistake as the code's.
 *
 * Follows the shapes the screens actually use to build rows: a literal,
 * a ternary of literals, an array, a local, and `list.map(x => ({...}))`.
 */
function rowShape(node, callNode, seen = new Set()) {
  const shapes = [];

  const walk = (n) => {
    if (!n) return;
    if (ts.isObjectLiteralExpression(n)) { shapes.push(objectKeys(n)); return; }
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return walk(n.expression);
    if (ts.isConditionalExpression(n)) { walk(n.whenTrue); walk(n.whenFalse); return; }
    if (ts.isArrayLiteralExpression(n)) { n.elements.forEach(walk); return; }
    // `[...a.map(...), ...b.map(...)]` — two screens build rows this way.
    if (ts.isSpreadElement(n)) return walk(n.expression);
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return walk(n.body);
    if (ts.isBlock(n)) {
      n.statements.forEach((st) => { if (ts.isReturnStatement(st)) walk(st.expression); });
      return;
    }
    if (ts.isCallExpression(n)) {
      // `rows.map(row => ({ ... }))` — the row is what the callback returns.
      if (ts.isPropertyAccessExpression(n.expression)) {
        const called = n.expression.name.text;
        // `rows.map(row => ({ ... }))` — the row is what the callback returns.
        if (called === 'map' && n.arguments[0]) walk(n.arguments[0]);
        // `.filter(...)` narrows the rows, it does not reshape them.
        else if (called === 'filter') walk(n.expression.expression);
      }
      return;
    }
    if (ts.isIdentifier(n) && !seen.has(n.text)) {
      seen.add(n.text);
      walk(localInitialiser(callNode, n.text));
    }
  };

  walk(node);
  if (!shapes.length) return null;

  const keys = new Set();
  let spread = false;
  for (const shape of shapes) {
    shape.keys.forEach((k) => keys.add(k));
    spread ||= shape.spread;
  }
  return { keys: [...keys], spread };
}

/** Walk outward from `db.from(...)`, collecting the methods called on it. */
function chainOf(root) {
  const steps = [];
  let cur = root;
  while (
    cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur
    && cur.parent.parent && ts.isCallExpression(cur.parent.parent)
    && cur.parent.parent.expression === cur.parent
  ) {
    steps.push({ method: cur.parent.name.text, args: cur.parent.parent.arguments });
    cur = cur.parent.parent;
  }
  return steps;
}

// A value the builder will bind. Its type never reaches SQL, so a
// placeholder of the right shape is enough to prove the chain builds.
const DUMMY = '00000000-0000-0000-0000-000000000000';

function bodyOf(table, steps, callNode) {
  const body = { table, op: 'select', filters: [] };
  const unknown = [];
  let skip = false;

  for (const { method, args } of steps) {
    switch (method) {
      case 'select': {
        body.columns = args.length ? (literal(args[0]) ?? '*') : '*';
        const opts = objectKeys(args[1]);
        if (opts && (opts.keys.includes('head') || opts.keys.includes('count'))) {
          body.countOnly = true;
        }
        break;
      }

      case 'insert':
      case 'update': {
        body.op = method;
        const found = rowShape(args[0], callNode);
        if (!found) {
          // Not readable, so not checkable. Reporting a build failure
          // here would be the reader failing, not the call site.
          unknown.push(`${method}() payload cannot be read statically`);
          skip = true;
          break;
        }
        if (found.spread) unknown.push(`${method}() spreads a value`);
        const row = Object.fromEntries(found.keys.map((k) => [k, DUMMY]));
        if (method === 'insert') body.rows = row; else body.patch = row;
        break;
      }

      case 'delete':
        body.op = 'delete';
        break;

      case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
      case 'like': case 'ilike': {
        const col = literal(args[0]);
        if (col) body.filters.push({ col, op: method, val: DUMMY });
        else unknown.push(`${method}() column is not a literal`);
        break;
      }

      case 'in': {
        const col = literal(args[0]);
        if (col) body.filters.push({ col, op: 'in', val: [DUMMY] });
        else unknown.push('in() column is not a literal');
        break;
      }

      case 'is': {
        const col = literal(args[0]);
        if (col) body.filters.push({ col, op: 'is', val: null });
        break;
      }

      case 'not': {
        const col = literal(args[0]);
        if (col) body.filters.push({ col, op: 'notin', val: [DUMMY] });
        break;
      }

      case 'match': {
        const o = objectKeys(args[0]);
        if (o) o.keys.forEach((col) => body.filters.push({ col, op: 'eq', val: DUMMY }));
        else unknown.push('match() is not a literal');
        break;
      }

      case 'order': {
        const col = literal(args[0]);
        if (col) body.order = { col, asc: true };
        break;
      }

      case 'limit':
        body.limit = 10;
        break;

      case 'single':
      case 'maybeSingle':
        body.limit = 2;
        break;

      default:
        break;
    }
  }
  return { body, unknown, skip };
}

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------
const failures = [];
const unreadable = [];
let checked = 0;
let rpcChecked = 0;

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (n) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;

  const visit = (node) => {
    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'db') {
      const method = node.expression.name.text;

      if (method === 'from') {
        const table = literal(node.arguments[0]);
        if (!table) {
          unreadable.push(`${file}:${lineOf(node)} from() table is not a literal`);
        } else {
          const { body, unknown, skip } = bodyOf(table, chainOf(node), node);
          unknown.forEach((u) => unreadable.push(`${file}:${lineOf(node)} ${table}: ${u}`));
          if (skip) { ts.forEachChild(node, visit); return; }
          checked++;
          try {
            build(body);
          } catch (err) {
            failures.push(`${file}:${lineOf(node)}  ${table}.${body.op}  ${err.message}`);
          }
        }
      }

      if (method === 'rpc') {
        const fn = literal(node.arguments[0]);
        if (!fn) {
          unreadable.push(`${file}:${lineOf(node)} rpc() name is not a literal`);
        } else {
          rpcChecked++;
          const declared = RPCS[fn];
          if (!declared) {
            failures.push(`${file}:${lineOf(node)}  rpc ${fn} is not in the whitelist`);
          } else {
            const passed = objectKeys(node.arguments[1]);
            if (!passed) {
              unreadable.push(`${file}:${lineOf(node)} rpc ${fn} arguments are not a literal`);
            } else {
              // Arguments are matched by name, so a spelling that differs
              // from the declaration binds null and fails silently.
              const missing = declared.filter((d) => !passed.keys.includes(d));
              const extra = passed.keys.filter((k) => !declared.includes(k));
              if (missing.length || extra.length) {
                failures.push(
                  `${file}:${lineOf(node)}  rpc ${fn}: `
                  + [
                    missing.length ? `missing ${missing.join(', ')}` : '',
                    extra.length ? `unknown ${extra.join(', ')}` : '',
                  ].filter(Boolean).join('; '),
                );
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

await vite.close();

// ---------------------------------------------------------------------
// Every whitelisted function must exist somewhere.
//
// Naming a function in the whitelist does not create it. All three stock
// functions were listed, called from the movement-orders screen, and
// defined in no file and no database — and because the call sites logged
// the failure rather than showing it, nothing said so for the length of
// a sprint.
// ---------------------------------------------------------------------
const sqlText = readdirSync('db')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join('db', f), 'utf8'))
  .join('\n')
  .toLowerCase();

for (const fn of Object.keys(RPCS)) {
  const name = fn.toLowerCase();
  const defined = sqlText.includes(`function public.${name}(`)
    || sqlText.includes(`function ${name}(`);
  if (!defined) failures.push(`db/: rpc ${fn} is whitelisted but defined in no sql file`);
}

console.log(`\n  ${checked} query chains and ${rpcChecked} function calls read from ${files.length} files\n`);

if (unreadable.length) {
  console.log(`  ${unreadable.length} could not be read statically (not a failure):`);
  for (const u of unreadable) console.log(`    - ${u}`);
  console.log('');
}

if (failures.length) {
  console.log(`  ${failures.length} CALL SITES THE WHITELIST WOULD REFUSE:\n`);
  for (const f of failures) console.log(`    ${f}`);
  console.log('');
  process.exit(1);
}

console.log(`ALL ${checked + rpcChecked} CALL SITES AGREE WITH THE WHITELIST\n`);
