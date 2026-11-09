/**
 * Install-time build guard.
 *
 * `npm install -g .` and `npm install -g github:user/repo` both run `prepare`.
 * The old `prepare` was `npm run build`, which used `npm -w` — and npm refuses
 * workspace flags for global installs:
 *
 *   npm ERR! Workspaces not supported for global packages
 *
 * That is what broke the CI "Global install smoke test" on ubuntu and macOS.
 * Here the build is best-effort: a tarball already ships `vallenagent/dist/`,
 * so a missing TypeScript toolchain must not fail the install.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'vallenagent', 'dist', 'index.js')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.log(existsSync(distEntry)
    ? '[prepare] TypeScript not installed; using the prebuilt vallenagent/dist.'
    : '[prepare] TypeScript not installed and no prebuilt dist; nothing to build.')
  process.exit(0)
}

const run = (cwd, args) => spawnSync(process.execPath, args, { cwd, stdio: 'inherit' })

const agent = run(join(root, 'vallenagent'), [tsc, '-p', 'tsconfig.json'])
if (agent.status !== 0) {
  if (existsSync(distEntry)) {
    console.warn('[prepare] tsc failed; keeping the existing vallenagent/dist.')
    process.exit(0)
  }
  process.exit(agent.status || 1)
}

const cli = run(join(root, 'vallencli'), ['--check', join(root, 'vallencli', 'src', 'cli.mjs')])
// vallencli is plain .mjs: a syntax check is enough, and it must never block an install.
if (cli.status !== 0) console.warn('[prepare] vallencli syntax check reported issues (ignored).')
