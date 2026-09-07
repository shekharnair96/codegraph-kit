"use strict";
/**
 * TypeScript/JavaScript extraction via the TypeScript compiler API.
 *
 * Why the compiler and not a regex/tree walker: the kit's `plan`, `impact` and `trace` commands
 * are only as good as the references/calls edges. The checker resolves an identifier to its
 * declaration across files, through re-exports, path aliases and index files, which is exactly
 * the "who uses X" question the graph exists to answer.
 *
 * Output contract (consumed by codegraph-ext/*.cjs):
 *   nodes:  kind in file|import|function|method|class|interface|type_alias|enum|enum_member|
 *           constant|variable|property|namespace; ids 'file:<rel>' or '<kind>:<md5>'
 *   edges:  contains (file/class -> member), imports (file -> import node, file -> file),
 *           calls / references (enclosing symbol -> declaration), extends, implements
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const LANG_BY_EXT = { ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript" };
const languageOf = rel => LANG_BY_EXT[path.extname(rel).toLowerCase()] || "unknown";

const MAX_SIG = 160;
const MAX_DOC = 400;
const oneLine = s => String(s).replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const nodeId = (kind, rel, qname, extra) =>
  `${kind}:${crypto.createHash("md5").update(`${rel}::${qname}::${extra || ""}`).digest("hex")}`;

// ---------- compiler host ----------
function buildProgram(root, files) {
  const tsconfig = ["tsconfig.json", "jsconfig.json"].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  let options = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    resolveJsonModule: true,
    allowSyntheticDefaultImports: true,
  };
  if (tsconfig) {
    try {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig), {}, tsconfig);
        options = { ...options, ...parsed.options };
      }
    } catch (_) {
      /* keep defaults */
    }
  }
  // Only bind, never type-check or emit; skip the standard library and @types entirely.
  Object.assign(options, { noEmit: true, skipLibCheck: true, noLib: true, types: [], noResolve: false, allowJs: true });
  delete options.rootDir;
  delete options.outDir;
  delete options.declaration;
  delete options.composite;
  delete options.incremental;
  const program = ts.createProgram(files.map(f => f.abs), options);
  return { program, checker: program.getTypeChecker(), tsconfig: tsconfig ? path.relative(root, tsconfig) : null };
}

// ---------- helpers ----------
const hasFlag = (node, flag) => (ts.getCombinedModifierFlags(node) & flag) !== 0;
const nameOf = node => (node.name && ts.isIdentifier(node.name) ? node.name.text : node.name && ts.isStringLiteral(node.name) ? node.name.text : null);

function jsDocOf(node) {
  const docs = ts.getJSDocCommentsAndTags(node);
  for (const d of docs) {
    if (ts.isJSDoc(d) && d.comment) {
      const text = typeof d.comment === "string" ? d.comment : d.comment.map(c => c.text || "").join("");
      if (text.trim()) return clip(oneLine(text), MAX_DOC);
    }
  }
  return null;
}

function typeParams(node) {
  return node.typeParameters ? node.typeParameters.map(t => t.getText()) : [];
}
function decoratorsOf(node) {
  const decs = ts.canHaveDecorators && ts.canHaveDecorators(node) ? ts.getDecorators(node) : null;
  return decs ? decs.map(d => clip(oneLine(d.expression.getText()), 60)) : [];
}
function visibilityOf(node) {
  if (hasFlag(node, ts.ModifierFlags.Private)) return "private";
  if (hasFlag(node, ts.ModifierFlags.Protected)) return "protected";
  if (node.name && ts.isPrivateIdentifier(node.name)) return "private";
  return "public";
}

function fnSignature(fn) {
  const params = fn.parameters.map(p => p.getText()).join(", ");
  const ret = fn.type ? `: ${fn.type.getText()}` : "";
  return clip(oneLine(`(${params})${ret}`), MAX_SIG);
}
function isFunctionLike(init) {
  return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}
function unwrapInit(init) {
  // React.memo(fn), forwardRef(fn), styled(...)`` etc.: peek at the first function-valued arg
  let cur = init;
  for (let i = 0; i < 3 && cur; i++) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression?.(cur) || ts.isTypeAssertionExpression?.(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur) && cur.arguments.some(isFunctionLike)) cur = cur.arguments.find(isFunctionLike);
    else break;
  }
  return cur;
}

// ---------- per-file extraction ----------
function extractProject(root, files, opts = {}) {
  const { program, checker, tsconfig } = buildProgram(root, files);
  const now = Date.now();
  const relOfAbs = new Map(files.map(f => [path.resolve(f.abs), f.rel]));
  const nodes = [];
  const edges = [];
  const fileRows = [];
  const unresolved = [];
  const declToId = new Map(); // ts.Node (declaration) -> node id
  const seenEdge = new Set();
  const pending = []; // heritage clauses, resolved in pass 2 (targets may live in later files)
  const perFileNodeCount = new Map();

  const pushNode = n => {
    nodes.push(n);
    perFileNodeCount.set(n.filePath, (perFileNodeCount.get(n.filePath) || 0) + 1);
  };
  const pushEdge = e => {
    const key = `${e.source}|${e.target}|${e.kind}|${e.line ?? ""}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push(e);
  };

  // ----- pass 1: declarations -----
  for (const f of files) {
    const sf = program.getSourceFile(f.abs);
    if (!sf) {
      fileRows.push({ path: f.rel, contentHash: "", language: languageOf(f.rel), size: f.size, modifiedAt: f.mtimeMs, indexedAt: now, nodeCount: 0, errors: ["not parsed"] });
      continue;
    }
    const language = languageOf(f.rel);
    const text = sf.getFullText();
    const lineCount = sf.getLineStarts().length;
    const fileId = `file:${f.rel}`;
    pushNode({ id: fileId, kind: "file", name: path.basename(f.rel), qualifiedName: f.rel, filePath: f.rel, language, startLine: 1, endLine: lineCount, startColumn: 0, endColumn: 0, updatedAt: now });
    declToId.set(sf, fileId);

    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exportedNames = new Set();
    if (moduleSymbol && moduleSymbol.exports) {
      moduleSymbol.exports.forEach((sym, key) => {
        exportedNames.add(String(key));
        // `export { a as b }` / `export default a`: mark the local declaration too
        try {
          const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
          (target.declarations || []).forEach(d => exportedNames.add(`@${d.pos}`));
        } catch (_) {
          /* ignore */
        }
      });
    }
    // CommonJS: `module.exports = { a, b }`, `module.exports.a = …`, `exports.a = …`
    for (const m of text.matchAll(/(?:module\.)?exports\s*=\s*\{([^}]*)\}/g)) {
      m[1].split(",").forEach(part => {
        const name = part.split(":")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name);
      });
    }
    for (const m of text.matchAll(/(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g)) exportedNames.add(m[1]);
    const isExported = (node, name) => hasFlag(node, ts.ModifierFlags.Export) || exportedNames.has(name) || exportedNames.has(`@${node.pos}`);

    const pos = node => {
      const s = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const e = sf.getLineAndCharacterOfPosition(node.getEnd());
      return { startLine: s.line + 1, endLine: e.line + 1, startColumn: s.character, endColumn: e.character };
    };

    const declare = (node, kind, name, parentQ, parentId, extra = {}) => {
      const qualifiedName = parentQ ? `${parentQ}.${name}` : name;
      const id = nodeId(kind, f.rel, qualifiedName, node.pos);
      const p = pos(node);
      pushNode({
        id, kind, name, qualifiedName, filePath: f.rel, language, ...p,
        docstring: opts.extractDocstrings === false ? null : jsDocOf(node),
        signature: extra.signature || null,
        visibility: extra.visibility || null,
        isExported: extra.isExported ?? isExported(node, name),
        isAsync: hasFlag(node, ts.ModifierFlags.Async),
        isStatic: hasFlag(node, ts.ModifierFlags.Static),
        isAbstract: hasFlag(node, ts.ModifierFlags.Abstract),
        decorators: decoratorsOf(node),
        typeParameters: typeParams(node),
        updatedAt: now,
      });
      declToId.set(node, id);
      pushEdge({ source: parentId, target: id, kind: "contains" });
      return { id, qualifiedName };
    };

    const visit = (node, parentQ, parentId) => {
      // ---- imports ----
      if (ts.isImportDeclaration(node) || (ts.isImportEqualsDeclaration(node) && node.moduleReference && ts.isExternalModuleReference(node.moduleReference))) {
        const specNode = ts.isImportDeclaration(node) ? node.moduleSpecifier : node.moduleReference.expression;
        const spec = specNode && ts.isStringLiteral(specNode) ? specNode.text : "?";
        const id = nodeId("import", f.rel, spec, node.pos);
        const p = pos(node);
        pushNode({ id, kind: "import", name: spec, qualifiedName: spec, filePath: f.rel, language, ...p, signature: clip(oneLine(node.getText(sf)), MAX_SIG), updatedAt: now });
        declToId.set(node, id);
        pushEdge({ source: fileId, target: id, kind: "contains" });
        const resolved = resolveModule(spec, sf.fileName);
        const names = [];
        if (ts.isImportDeclaration(node) && node.importClause) {
          const c = node.importClause;
          if (c.name) names.push("default");
          if (c.namedBindings) {
            if (ts.isNamespaceImport(c.namedBindings)) names.push("*");
            else c.namedBindings.elements.forEach(el => names.push((el.propertyName || el.name).text));
          }
        }
        const meta = { specifier: spec, names, resolvedBy: resolved ? "compiler" : "unresolved", confidence: resolved ? 1 : 0 };
        if (resolved) meta.resolved = resolved;
        pushEdge({ source: fileId, target: id, kind: "imports", metadata: meta, line: p.startLine, col: p.startColumn });
        if (resolved) pushEdge({ source: fileId, target: `file:${resolved}`, kind: "imports", metadata: { specifier: spec, names, resolvedBy: "compiler", confidence: 1 }, line: p.startLine, col: p.startColumn });
        return;
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // `export * from './x'` / `export { a } from './x'` — a file->file import edge is all the graph needs
        const resolved = resolveModule(node.moduleSpecifier.text, sf.fileName);
        const p = pos(node);
        if (resolved) pushEdge({ source: fileId, target: `file:${resolved}`, kind: "imports", metadata: { specifier: node.moduleSpecifier.text, reexport: true, resolvedBy: "compiler", confidence: 1 }, line: p.startLine, col: p.startColumn });
        return;
      }
      // ---- declarations ----
      if (ts.isFunctionDeclaration(node)) {
        const name = nameOf(node) || (hasFlag(node, ts.ModifierFlags.Default) ? "default" : null);
        if (name) {
          const d = declare(node, "function", name, parentQ, parentId, { signature: fnSignature(node) });
          node.body && visitChildren(node.body, d.qualifiedName, d.id);
        }
        return;
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const name = nameOf(node) || (hasFlag(node, ts.ModifierFlags.Default) ? "default" : null);
        if (!name) return visitChildren(node, parentQ, parentId);
        const heritage = (node.heritageClauses || []).map(h => h.getText(sf)).join(" ");
        const d = declare(node, "class", name, parentQ, parentId, { signature: clip(oneLine(`class ${name} ${heritage}`), MAX_SIG) });
        for (const h of node.heritageClauses || []) {
          const kind = h.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
          for (const t of h.types) heritageEdge(d.id, t.expression, kind);
        }
        for (const m of node.members) visitMember(m, d.qualifiedName, d.id);
        return;
      }
      if (ts.isInterfaceDeclaration(node)) {
        const d = declare(node, "interface", node.name.text, parentQ, parentId, { signature: clip(oneLine(`interface ${node.name.text}${node.typeParameters ? "<" + typeParams(node).join(", ") + ">" : ""}`), MAX_SIG) });
        for (const h of node.heritageClauses || []) for (const t of h.types) heritageEdge(d.id, t.expression, "extends");
        for (const m of node.members) {
          const mn = nameOf(m);
          if (mn && (ts.isPropertySignature(m) || ts.isMethodSignature(m))) {
            declare(m, "property", mn, d.qualifiedName, d.id, { signature: clip(oneLine(m.getText(sf)), MAX_SIG), isExported: false });
          }
        }
        return;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        declare(node, "type_alias", node.name.text, parentQ, parentId, { signature: clip(oneLine(`type ${node.name.text} = ${node.type.getText(sf)}`), MAX_SIG) });
        return;
      }
      if (ts.isEnumDeclaration(node)) {
        const d = declare(node, "enum", node.name.text, parentQ, parentId, { signature: `enum ${node.name.text}` });
        for (const m of node.members) {
          const mn = nameOf(m);
          if (mn) declare(m, "enum_member", mn, d.qualifiedName, d.id, { signature: clip(oneLine(m.getText(sf)), MAX_SIG), isExported: false });
        }
        return;
      }
      if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const d = declare(node, "namespace", node.name.text, parentQ, parentId, { signature: `namespace ${node.name.text}` });
        node.body && visitChildren(node.body, d.qualifiedName, d.id);
        return;
      }
      if (ts.isVariableStatement(node)) {
        const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const decl of node.declarationList.declarations) visitVariable(decl, isConst, node, parentQ, parentId);
        return;
      }
      if (ts.isVariableDeclarationList(node)) {
        // `for (const x of …)`, nested lists — treat like a statement without export flags
        const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
        for (const decl of node.declarations) visitVariable(decl, isConst, node, parentQ, parentId);
        return;
      }
      visitChildren(node, parentQ, parentId);
    };

    const visitVariable = (decl, isConst, stmt, parentQ, parentId) => {
      if (!ts.isIdentifier(decl.name)) {
        // destructuring: no node, but still walk the initializer for references
        decl.initializer && visitChildren(decl.initializer, parentQ, parentId);
        return;
      }
      const name = decl.name.text;
      const init = unwrapInit(decl.initializer);
      if (isFunctionLike(init)) {
        const d = declare(decl, "function", name, parentQ, parentId, { signature: fnSignature(init), isExported: isExported(stmt, name) || hasFlag(decl, ts.ModifierFlags.Export) });
        // async arrow: flag lives on the arrow, not the declaration
        if (init.modifiers && init.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) nodes[nodes.length - 1].isAsync = true;
        init.body && visitChildren(init.body, d.qualifiedName, d.id);
        // decorator-style wrappers (memo(fn)) — walk the call's other args for refs
        if (decl.initializer && decl.initializer !== init) visitChildren(decl.initializer, d.qualifiedName, d.id);
        return;
      }
      const kind = isConst ? "constant" : "variable";
      const initText = decl.initializer ? clip(oneLine(decl.initializer.getText(sf)), MAX_SIG - 2) : "";
      const typeText = decl.type ? `: ${clip(oneLine(decl.type.getText(sf)), 60)}` : "";
      const d = declare(decl, kind, name, parentQ, parentId, { signature: `${typeText}${initText ? " = " + initText : ""}`.trim() || null, isExported: isExported(stmt, name) || hasFlag(decl, ts.ModifierFlags.Export) });
      decl.initializer && visitChildren(decl.initializer, d.qualifiedName, d.id);
    };

    const visitMember = (m, parentQ, parentId) => {
      const mn = ts.isConstructorDeclaration(m) ? "constructor" : nameOf(m);
      if (!mn) return visitChildren(m, parentQ, parentId);
      if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        const d = declare(m, "method", mn, parentQ, parentId, { signature: fnSignature(m), visibility: visibilityOf(m), isExported: false });
        m.body && visitChildren(m.body, d.qualifiedName, d.id);
        return;
      }
      if (ts.isPropertyDeclaration(m)) {
        const init = unwrapInit(m.initializer);
        if (isFunctionLike(init)) {
          const d = declare(m, "method", mn, parentQ, parentId, { signature: fnSignature(init), visibility: visibilityOf(m), isExported: false });
          init.body && visitChildren(init.body, d.qualifiedName, d.id);
          return;
        }
        const d = declare(m, "property", mn, parentQ, parentId, { signature: clip(oneLine(m.getText(sf)), MAX_SIG), visibility: visibilityOf(m), isExported: false });
        m.initializer && visitChildren(m.initializer, d.qualifiedName, d.id);
        return;
      }
      visitChildren(m, parentQ, parentId);
    };

    const visitChildren = (node, parentQ, parentId) => ts.forEachChild(node, c => visit(c, parentQ, parentId));

    const heritageEdge = (sourceId, expr, kind) => pending.push({ sourceId, expr, kind, sf });

    visitChildren(sf, null, fileId);
    fileRows.push({
      path: f.rel,
      contentHash: crypto.createHash("sha256").update(text).digest("hex"),
      language,
      size: f.size,
      modifiedAt: f.mtimeMs,
      indexedAt: now,
      nodeCount: 0, // filled after pass 1
      errors: null,
    });
  }
  for (const fr of fileRows) fr.nodeCount = (perFileNodeCount.get(fr.path) || 1) - 1;

  // ----- pass 2: references / calls / heritage -----
  function resolveModule(spec, fromAbs) {
    try {
      const r = ts.resolveModuleName(spec, fromAbs, program.getCompilerOptions(), ts.sys);
      const resolved = r.resolvedModule && r.resolvedModule.resolvedFileName;
      if (!resolved) return null;
      return relOfAbs.get(path.resolve(resolved)) || null;
    } catch (_) {
      return null;
    }
  }

  // declaration -> the graph node id that owns it (walk up: a method's body param → the method, etc.)
  function idForDeclaration(decl) {
    let cur = decl;
    while (cur) {
      const id = declToId.get(cur);
      if (id) return { id, exact: cur === decl };
      cur = cur.parent;
    }
    return null;
  }
  function targetOfIdentifier(ident) {
    let sym = checker.getSymbolAtLocation(ident);
    if (!sym) return null;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch (_) {
        return null;
      }
    }
    const decls = sym.declarations || [];
    for (const d of decls) {
      if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) continue; // still an alias
      const hit = idForDeclaration(d);
      if (hit && hit.exact) return { id: hit.id, external: false };
    }
    // declaration exists but isn't a node (parameter, local destructure, lib symbol)
    const first = decls[0];
    if (!first) return null;
    const sfName = first.getSourceFile().fileName;
    if (!relOfAbs.has(path.resolve(sfName))) return { id: null, external: true, name: sym.getName() };
    return null;
  }
  function enclosingId(node) {
    let cur = node.parent;
    while (cur) {
      const id = declToId.get(cur);
      if (id) return id;
      cur = cur.parent;
    }
    return null;
  }
  function isDeclarationName(ident) {
    const p = ident.parent;
    return p && p.name === ident && (ts.isDeclaration(p) || ts.isPropertyAssignment(p) || ts.isBindingElement(p) || ts.isShorthandPropertyAssignment(p)) && !ts.isPropertyAccessExpression(p);
  }
  function callKind(ident) {
    let p = ident.parent;
    // obj.method( … ) — the identifier is the `name` of a property access that is the callee
    if (p && ts.isPropertyAccessExpression(p) && p.name === ident) p = p.parent;
    if (p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.expression === ident || (ts.isPropertyAccessExpression(p.expression) && p.expression.name === ident))) return "calls";
    if (p && (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === ident) return "calls";
    if (p && ts.isTaggedTemplateExpression(p) && p.tag === ident) return "calls";
    return "references";
  }

  for (const h of pending) {
    const ident = ts.isPropertyAccessExpression(h.expr) ? h.expr.name : h.expr;
    if (!ts.isIdentifier(ident)) continue;
    const t = targetOfIdentifier(ident);
    if (t && t.id && t.id !== h.sourceId) {
      const p = h.sf.getLineAndCharacterOfPosition(ident.getStart(h.sf));
      pushEdge({ source: h.sourceId, target: t.id, kind: h.kind, metadata: { resolvedBy: "compiler", confidence: 1 }, line: p.line + 1, col: p.character });
    }
  }

  for (const f of files) {
    const sf = program.getSourceFile(f.abs);
    if (!sf) continue;
    const fileId = `file:${f.rel}`;
    const language = languageOf(f.rel);
    const walk = node => {
      if (ts.isIdentifier(node) && !isDeclarationName(node) && node.parent && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) && !ts.isNamespaceImport(node.parent)) {
        // `export { a }` names are declarations of the export, not uses
        if (ts.isExportSpecifier(node.parent)) return;
        const t = targetOfIdentifier(node);
        if (t) {
          const source = enclosingId(node) || fileId;
          const kind = callKind(node);
          const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          if (t.id) {
            if (t.id !== source) pushEdge({ source, target: t.id, kind, metadata: { resolvedBy: "compiler", confidence: 1 }, line: p.line + 1, col: p.character });
          } else if (t.external && opts.recordUnresolved) {
            unresolved.push({ fromNodeId: source, name: t.name, kind, line: p.line + 1, col: p.character, filePath: f.rel, language });
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }

  return { nodes, edges, files: fileRows, unresolved, tsconfig };
}

module.exports = { extract: extractProject, languageOf };
