#!/usr/bin/env node
/**
 * Build step: produce the release artifact `main.js` from the committed source `src/main.js`.
 *
 * The community directory scans every release and runs the repo's build command
 * (`build` → `build:plugin` → `compile`, first one it finds) so it can compare what the build
 * produces against the assets attached to the release. That is why `main.js` lives in `src/` and
 * is NOT committed at the repo root: it is a build output that belongs to the release.
 *
 * This plugin is a hand-written single-file CommonJS module and needs no bundler, so the build is
 * a copy plus a sanity check — no dependencies, nothing to install.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'

const SRC = 'src/main.js'
const OUT = 'main.js'

const code = readFileSync(SRC, 'utf8')
if (!code.includes('module.exports')) {
  console.error(`${SRC} does not look like a plugin entry point (no module.exports). Refusing to build.`)
  process.exit(1)
}
writeFileSync(OUT, code)
console.log(`built ${OUT}: ${statSync(OUT).size} bytes (source ${SRC})`)
