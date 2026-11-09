#!/usr/bin/env node
// Deterministic cross-platform test runner.
//
// `node --test tests/` behaves differently per Node version (Node 24 treats the
// directory as a module entry point) and shell globs are not expanded by cmd.exe.
// Enumerating the files here works identically on Linux, macOS, Windows and Termux.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const dir = resolve(process.cwd(), process.argv[2] || 'tests')
let files
try {
  files = readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(dir, name))
} catch (error) {
  console.error(`Cannot read test directory ${dir}: ${error.message}`)
  process.exit(1)
}
if (!files.length) {
  console.error(`No *.test.mjs files found in ${dir}`)
  process.exit(1)
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
if (result.error) {
  console.error(`Could not start the test runner: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
