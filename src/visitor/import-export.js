import MagicString from "../magic-string.js"
import NullObject from "../null-object.js"
import Visitor from "../visitor.js"

import encodeId from "../util/encode-id.js"
import getNamesFromPattern from "../parse/get-names-from-pattern.js"
import toStringLiteral from "../util/to-string-literal.js"

const ANON_NAME = encodeId("default")

const codeOfCR = "\r".charCodeAt(0)

const { keys } = Object

class ImportExportVisitor extends Visitor {
  finalizeHoisting() {
    const { top } = this
    const codeToInsert =
      top.hoistedPrefixString +
      toModuleExport(this, top.hoistedExportsMap) +
      top.hoistedExportsString +
      top.hoistedImportsString

    this.magicString.prependRight(top.insertCharIndex, codeToInsert)
  }

  reset(rootPath, code, options) {
    this.addedDynamicImport = false
    this.addedImportExport = false
    this.addedImportMeta = false
    this.assignableExports = new NullObject
    this.assignableImports = new NullObject
    this.changed = false
    this.code = code
    this.esm = options.esm,
    this.exportSpecifiers = new NullObject
    this.exportStarNames = []
    this.generateVarDeclarations = options.generateVarDeclarations
    this.madeChanges = false
    this.magicString = new MagicString(code)
    this.moduleSpecifiers = new NullObject
    this.runtimeName = options.runtimeName
    this.top = rootPath.stack[0].top
  }

  visitCallExpression(path) {
    const { callee } = path.getValue()

    if (callee.type === "Import") {
      // Support dynamic import:
      // import("mod")
      this.changed =
      this.addedDynamicImport = true
      overwrite(this, callee.start, callee.end, this.runtimeName + ".i")
    }

    this.visitChildren(path)
  }

  visitImportDeclaration(path) {
    if (! this.esm) {
      return
    }

    // Suport import statements:
    // import defaultName from "mod"
    // import * as name from "mod"
    // import { export as alias } from "mod"
    // import { export1 , export2, ...exportN } from "mod"
    // import { export1 , export2 as alias2, [...] } from "mod"
    // import defaultName, { export1, [ , [...] ] } from "mod"
    // import defaultName, * as name from "mod"
    // import "mod"
    this.changed =
    this.addedImportExport = true

    let i = -1
    const node = path.getValue()
    const { specifiers } = node
    const specifierMap = createSpecifierMap(this, node)
    const lastIndex = specifiers.length - 1

    let hoistedCode = specifiers.length
      ? (this.generateVarDeclarations ? "var " : "let ")
      : ""

    for (const specifier of specifiers) {
      hoistedCode +=
        specifier.local.name +
        (++i === lastIndex ? ";" : ",")
    }

    hoistedCode += toModuleImport(
      this,
      getSourceString(this, node),
      specifierMap
    )

    hoistImports(this, node, hoistedCode)
    addAssignableImports(this, specifierMap)
  }

  visitExportAllDeclaration(path) {
    if (! this.esm) {
      return
    }

    // Support re-exporting an imported module:
    // export * from "mod"
    this.changed =
    this.addedImportExport = true

    const { moduleSpecifiers } = this
    const node = path.getValue()
    const { source } = node
    const specifierString = getSourceString(this, node)
    const specifierName = specifierString.slice(1, -1)

    const hoistedCode = pad(
      this,
      this.runtimeName + ".w(" + specifierString,
      node.start,
      source.start
    ) + pad(
      this,
      ',[["*",' + this.runtimeName + ".n()]]);",
      source.end,
      node.end
    )

    this.exportStarNames.push(specifierName)

    if (! (specifierName in moduleSpecifiers)) {
      moduleSpecifiers[specifierName] = new NullObject
    }

    hoistImports(this, node, hoistedCode)
  }

  visitExportDefaultDeclaration(path) {
    if (! this.esm) {
      return
    }

    this.changed =
    this.addedImportExport = true

    // Export specifier states:
    //   1 - Own
    //   2 - Imported
    //   3 - Conflicted
    this.exportSpecifiers.default = 1

    const node = path.getValue()
    const { declaration } = node
    const { id, type, functionParamsStart } = declaration

    if (type === "FunctionDeclaration" ||
        (id && type === "ClassDeclaration")) {
      // Support exporting default class and function declarations:
      // export default function named() {}
      const name = id ? id.name : safeName(ANON_NAME, this.top.idents)

      if (! id) {
        // Convert anonymous functions to named functions so they are hoisted.
        this.madeChanges = true
        this.magicString.prependRight(
          functionParamsStart,
          " " + name
        )
      }

      // If the exported default value is a function or class declaration,
      // it's important that the declaration be visible to the rest of the
      // code in the exporting module, so we must avoid compiling it to a
      // named function or class expression.
      hoistExports(this, node,
        addToSpecifierMap(this, new NullObject, "default", name),
        "declaration"
      )
    } else {
      // Otherwise, since the exported value is an expression, we use the
      // special `runtime.default(value)` form.
      path.call(this, "visitWithoutReset", "declaration")

      let prefix = this.runtimeName + ".d("
      let suffix = ");"

      if (type === "SequenceExpression") {
        // If the exported expression is a comma-separated sequence expression,
        // `this.code.slice(declaration.start, declaration.end)` may not include
        // the vital parentheses, so we should wrap the expression with parentheses
        // to make absolutely sure it is treated as a single argument to
        // `runtime.default()`, rather than as multiple arguments.
        prefix += "("
        suffix = ")" + suffix
      }

      overwrite(this, node.start, declaration.start, prefix)
      overwrite(this, declaration.end, node.end, suffix)
    }
  }

  visitExportNamedDeclaration(path) {
    if (! this.esm) {
      return
    }

    this.changed =
    this.addedImportExport = true

    const node = path.getValue()
    const { declaration } = node

    if (declaration) {
      const specifierMap = new NullObject
      const { id, type } = declaration

      if (id &&
          (type === "ClassDeclaration" ||
           type === "FunctionDeclaration")) {
        // Support exporting named class and function declarations:
        // export function named() {}
        const { name } = id
        addToSpecifierMap(this, specifierMap, name, name)
      } else if (type === "VariableDeclaration") {
        // Support exporting variable lists:
        // export let name1, name2, ..., nameN
        for (const decl of declaration.declarations) {
          const names = getNamesFromPattern(decl.id)

          for (const name of names) {
            addToSpecifierMap(this, specifierMap, name, name)
          }
        }
      }

      hoistExports(this, node, specifierMap, "declaration")

      // Skip adding declared names to `this.assignableExports` if the
      // declaration is a const-kinded VariableDeclaration, because the
      // assignmentVisitor doesn't need to worry about changes to these
      // variables.
      if (canExportedValuesChange(node)) {
        addAssignableExports(this, specifierMap)
      }

      return
    }

    if (! node.specifiers) {
      return
    }

    // Support exporting specifiers:
    // export { name1, name2, ..., nameN }
    let specifierMap = createSpecifierMap(this, node)

    if (node.source == null) {
      hoistExports(this, node, specifierMap)
      addAssignableExports(this, specifierMap)
      return
    }

    // Support re-exporting specifiers of an imported module:
    // export { name1, name2, ..., nameN } from "mod"
    const { exportSpecifiers } = this
    const newMap = new NullObject

    for (const name in specifierMap) {
      exportSpecifiers[name] = 1

      addToSpecifierMap(
        this,
        newMap,
        getLocal(specifierMap, name),
        this.runtimeName + ".entry._namespace." + name
      )
    }

    specifierMap = newMap

    hoistImports(this, node, toModuleImport(
      this,
      getSourceString(this, node),
      specifierMap
    ))
  }

  visitMetaProperty(path) {
    const { meta } = path.getValue()

    if (meta.name === "import") {
      // Support import.meta.
      this.changed =
      this.addedImportMeta = true
      overwrite(this, meta.start, meta.end, this.runtimeName + "._")
    }
  }
}

function addAssignableExports(visitor, specifierMap) {
  const { assignableExports } = visitor

  for (const name in specifierMap) {
    // It's tempting to record the exported name as the value here,
    // instead of true, but there can be more than one exported name
    // per local variable, and we don't actually use the exported
    // name(s) in the assignmentVisitor, so it's not worth the added
    // complexity of tracking unused information.
    assignableExports[getLocal(specifierMap, name)] = true
  }
}

function addAssignableImports(visitor, specifierMap) {
  const { assignableImports } = visitor

  for (const portedName in specifierMap) {
    for (const localName in specifierMap[portedName]) {
      assignableImports[localName] = true
    }
  }
}

function addToSpecifierMap(visitor, map, portedName, localName) {
  const locals = map[portedName] || (map[portedName] = new NullObject)
  locals[localName] = true
  return map
}

function canExportedValuesChange({ declaration, type }) {
  if (type === "ExportDefaultDeclaration") {
    return declaration.type === "FunctionDeclaration" ||
           declaration.type === "ClassDeclaration"
  }

  if (type === "ExportNamedDeclaration" &&
      declaration &&
      declaration.type === "VariableDeclaration" &&
      declaration.kind === "const") {
    return false
  }

  return true
}

// Returns a map of import or export specifier to their local variable names.
function createSpecifierMap(visitor, node) {
  const { specifiers } = node
  const specifierMap = new NullObject

  for (const specifier of specifiers) {
    const localName = specifier.local.name
    const { type } = specifier

    let portedName = null

    if (type === "ImportSpecifier") {
      portedName = specifier.imported.name
    } else if (type === "ImportDefaultSpecifier") {
      portedName = "default"
    } else if (type === "ImportNamespaceSpecifier") {
      portedName = "*"
    } else if (type === "ExportSpecifier") {
      portedName = specifier.exported.name
    }

    if (typeof localName === "string" &&
        typeof portedName === "string") {
      addToSpecifierMap(visitor, specifierMap, portedName, localName)
    }
  }

  return specifierMap
}

function getLocal(specifierMap, portedName) {
  for (const localName in specifierMap[portedName]) {
    return localName
  }
}

// Gets a string representation (including quotes) from an import or
// export declaration node.
function getSourceString(visitor, { source }) {
  return visitor.code.slice(source.start, source.end)
}

function hoistExports(visitor, node, map, childName) {
  if (childName) {
    preserveChild(visitor, node, childName)
  } else {
    preserveLine(visitor, node)
  }

  const { top } = visitor

  for (const portedName in map) {
    addToSpecifierMap(
      visitor,
      top.hoistedExportsMap,
      portedName,
      getLocal(map, portedName)
    )
  }
}

function hoistImports(visitor, node, hoistedCode) {
  preserveLine(visitor, node)
  visitor.top.hoistedImportsString += hoistedCode
}

function overwrite(visitor, oldStart, oldEnd, newCode) {
  const padded = pad(visitor, newCode, oldStart, oldEnd)

  if (oldStart !== oldEnd) {
    visitor.madeChanges = true
    visitor.magicString.overwrite(oldStart, oldEnd, padded)
  } else if (padded !== "") {
    visitor.madeChanges = true
    visitor.magicString.prependRight(oldStart, padded)
  }
}

function pad(visitor, newCode, oldStart, oldEnd) {
  const oldLines = visitor.code.slice(oldStart, oldEnd).split("\n")
  const oldLineCount = oldLines.length
  const newLines = newCode.split("\n")
  const lastIndex = newLines.length - 1
  let i = lastIndex - 1

  while (++i < oldLineCount) {
    const oldLine = oldLines[i]
    const lastCharCode = oldLine.charCodeAt(oldLine.length - 1)

    if (i > lastIndex) {
      newLines[i] = ""
    }

    if (lastCharCode === codeOfCR) {
      newLines[i] += "\r"
    }
  }

  return newLines.join("\n")
}

function preserveChild(visitor, node, childName) {
  const child = node[childName]
  overwrite(visitor, node.start, child.start, "")
}

function preserveLine(visitor, { end, start }) {
  overwrite(visitor, start, end, "")
}

function safeName(name, localNames) {
  return localNames.indexOf(name) === -1
    ? name
    : safeName(encodeId(name), localNames)
}

function toModuleExport(visitor, specifierMap) {
  let code = ""
  const names = keys(specifierMap)

  if (! names.length) {
    return code
  }

  let i = -1
  const lastIndex = names.length - 1
  const { exportSpecifiers } = visitor

  code += visitor.runtimeName + ".e(["

  for (const name of names) {
    exportSpecifiers[name] = 1

    code +=
      "[" + toStringLiteral(name) + ",()=>" +
      getLocal(specifierMap, name) +
      "]"

    if (++i !== lastIndex) {
      code += ","
    }
  }

  code += "]);"

  return code
}

function toModuleImport(visitor, specifierString, specifierMap) {
  const names = keys(specifierMap)
  const specifierName = specifierString.slice(1, -1)

  visitor.moduleSpecifiers[specifierName] = specifierMap

  let code = visitor.runtimeName + ".w(" + specifierString

  if (! names.length) {
    return code + ");"
  }

  let i = -1
  const lastIndex = names.length - 1

  code += ",["

  for (const name of names) {
    const localNames = keys(specifierMap[name])
    const valueParam = safeName("v", localNames)

    code +=
      // Generate plain functions, instead of arrow functions,
      // to avoid a perf hit in Node 4.
      "[" + toStringLiteral(name) + ",function(" + valueParam + "){" +
      // Multiple local variables become a compound assignment.
      localNames.join("=") + "=" + valueParam +
      "}]"

    if (++i !== lastIndex) {
      code += ","
    }
  }

  code += "]);"

  return code
}

export default new ImportExportVisitor
