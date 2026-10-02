/**
 * Jest resolver for the SHARED web test files (jest.config.js: shared-node, shared-rn).
 *
 * Those files live in the repository root and import root dependencies. Since P146 one of them
 * (tests/data/money.test.ts) uses fast-check, whose `pure-rand` dependency is reached through a pnpm
 * symlink and a `package.json` `exports` map; Jest's default resolver, run with this package's custom
 * `moduleDirectories`, could not resolve `pure-rand/generator/congruential32` from inside fast-check
 * ("Cannot find module"), although Node resolves it. Jest's resolver is tried first, unchanged; only
 * when it fails is Node's own resolution tried from the importing file's directory, which honours the
 * `exports` map and pnpm's symlinks. A request neither can resolve still throws the original error.
 */
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options)
  } catch (jestError) {
    try {
      return require.resolve(request, { paths: [options.basedir] })
    } catch {
      throw jestError
    }
  }
}
