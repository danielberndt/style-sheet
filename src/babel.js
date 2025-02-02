import evaluateSimple from 'babel-helper-evaluate-path'
import evaluateComplex from 'linaria/lib/babel/evaluate'
import jsx from '@babel/plugin-syntax-jsx'
import { create } from './factory'
const { StyleSheet, StyleResolver } = create()

// This function returns the extracted CSS to save in a .css file.
// It must be called after all the files are processed by Babel.
export function getCss() {
  return StyleResolver.getStyleSheet().flush()
}

export default function(babel) {
  return {
    name: 'style-sheet/babel',
    inherits: jsx,
    visitor: {
      Program: {
        exit(path, state) {
          const { types: t } = babel
          if (!state.hasStyleSheetImport && state.needsStyleSheetImport) {
            const importSpecifier = t.identifier(
              state.opts.importName || 'StyleSheet'
            )
            const importDeclaration = t.importDeclaration(
              [t.importSpecifier(importSpecifier, importSpecifier)],
              t.stringLiteral(state.opts.packageName || 'style-sheet')
            )
            path.node.body.unshift(importDeclaration)
          }
          if (!state.hasStylePropImport && state.needsStylePropImport) {
            const importSpecifier = t.identifier('createElement')
            const importDeclaration = t.importDeclaration(
              [t.importSpecifier(importSpecifier, importSpecifier)],
              t.stringLiteral(state.opts.stylePropPackageName)
            )
            path.node.body.unshift(importDeclaration)
          }
        },
      },
      JSXAttribute(path, state) {
        if (!state.opts.stylePropName) {
          state.opts.stylePropName = 'css'
        }
        if (path.node.name.name !== state.opts.stylePropName) {
          return
        }

        const value = path.get('value')
        if (!value.isJSXExpressionContainer()) {
          return
        }

        let expression = value.get('expression')

        const { types: t } = babel
        const cloneNode = t.cloneNode || t.cloneDeep
        const importName = state.opts.importName || 'StyleSheet'

        let isExpressionArray = false
        let expressions
        if (expression.isArrayExpression()) {
          isExpressionArray = true
          expressions = expression.get('elements')
        } else {
          expressions = [expression]
        }

        const hoisted = expressions
          .map(expression => {
            if (!expression.isPure()) {
              return
            }

            const replacement = t.callExpression(
              t.memberExpression(
                t.identifier(importName),
                t.identifier('create')
              ),
              [
                t.objectExpression([
                  t.objectProperty(
                    t.identifier('__styleProp'),
                    cloneNode(expression.node)
                  ),
                ]),
              ]
            )
            expression.replaceWith(replacement)
            processReferencePath(babel, expression, state)
            return expression.hoist()
          })
          .filter(Boolean)

        if (isExpressionArray && hoisted.length === expressions.length) {
          expression.hoist()
        }

        state.needsStylePropImport = true

        if (!state.opts.stylePropPackageName) {
          throw path.buildCodeFrameError(
            `
Found \`${state.opts.stylePropName}\` prop but you didn't specify the path to the custom createElement in the Babel configuration.
Please set the \`stylePropPackageName\` option.

{
  "plugins": [
    [
      "style-sheet/babel",
      {
        "stylePropName": "${state.opts.stylePropName}",
        "stylePropPackageName": "./path/to/createElement.js"
      }
    ]
  ]
}

Read more about how to create the style prop package at https://github.com/giuseppeg/style-sheet
`
          )
        }
      },
      ImportDeclaration(path, state) {
        const stylePropPackageName = state.opts.stylePropPackageName
        state.hasStylePropImport =
          path.node.source.value === stylePropPackageName

        const packageName = state.opts.packageName || 'style-sheet'
        if (path.node.source.value !== packageName) {
          return
        }
        const importName = state.opts.importName || 'StyleSheet'
        const specifier = path.get('specifiers').find(specifier => {
          return (
            specifier.isImportSpecifier() &&
            specifier.get('imported').node.name === importName
          )
        })
        if (!specifier) {
          return
        }

        state.hasStyleSheetImport = true

        // Find all the references to StyleSheet.create.
        const binding = path.scope.getBinding(specifier.node.local.name)

        if (!binding || !Array.isArray(binding.referencePaths)) {
          return
        }

        binding.referencePaths
          .map(referencePath => referencePath.parentPath.parentPath)
          .forEach(path => {
            if (path.isCallExpression()) {
              processReferencePath(babel, path, state)
            }
          })
      },
    },
  }
}

function processReferencePath(babel, path, state) {
  const t = babel.types
  const cloneNode = t.cloneNode || t.cloneDeep
  // From
  //
  //   StyleSheet.create({
  //     root: {
  //       color: 'red'
  //     }
  //   })
  //
  // grabs
  //
  //   {
  //     root: {
  //       color: 'red'
  //     }
  //   }
  const rulesPath = path.get('arguments')[0]
  const extractableProperties = []

  // For each property
  //
  //   root: {
  //     color: 'red'
  //   }
  const properties = rulesPath.get('properties')
  properties.forEach(property => {
    // Ignore complex stuff like spread elements for now.
    if (!property.isObjectProperty()) {
      return
    }
    // Try to resolve to static...
    // evaluate() will also compile static styles, which are the ones
    // that we will extract to file.
    const evaluated = evaluate(babel, property.get('value'), state)

    if (evaluated.value === null) {
      return
    }
    extractableProperties.push(
      t.objectProperty(
        cloneNode(property.get('key').node),
        t.arrayExpression(evaluated.value.map(value => t.stringLiteral(value)))
      )
    )
    property.remove()
  })

  // If we couldn't resolve anything we exit.
  if (extractableProperties.length === 0) {
    state.needsStyleSheetImport = true
    return
  }

  const extractedStylesObjectLiteral = t.objectExpression(extractableProperties)

  // When some rules could not be extracted (maybe there are dynamic styles)
  // we will spread StyleSheet.create({...}) to the replacement object
  //
  //   ({
  //    static: [/* ... */],
  //    ...StyleSheet.create({
  //      someDynamicRule: {
  //        color: props.color,
  //      }
  //    })
  //   })
  if (properties.length !== extractableProperties.length) {
    state.needsStyleSheetImport = true
    extractedStylesObjectLiteral.properties.push(
      t.spreadElement(cloneNode(path.node))
    )
  }
  path.replaceWith(extractedStylesObjectLiteral)
}

function compileRule(rule) {
  const compiled = StyleSheet.create({ static: rule }).static
  StyleResolver.resolve(compiled)
  return compiled
}

function evaluate(babel, path, state) {
  let result = evaluateSimple(path)
  if (result.confident) {
    return {
      value: compileRule(result.value),
      dependencies: [],
    }
  }

  try {
    result = evaluateComplex(
      path,
      babel.types,
      state.file.opts.filename,
      text => {
        return babel.transformSync(text, {
          babelrc: false,
          filename: state.file.opts.filename,
          plugins: [
            // Include this plugin to avoid extra config when using { module: false } for webpack
            '@babel/plugin-transform-modules-commonjs',
            '@babel/plugin-proposal-export-namespace-from',
            // We don't support dynamic imports when evaluating, but don't wanna syntax error
            // This will replace dynamic imports with an object that does nothing
            // eslint-disable-next-line no-undef
            require.resolve('linaria/lib/babel/dynamic-import-noop'),
          ],
          exclude: /node_modules/,
        })
      }
    )

    if (result.value !== null) {
      result.value = compileRule(result.value)
    }
  } catch (error) {
    result = { value: null, dependencies: [] }
  }

  return result
}
