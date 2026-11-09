import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
// HOME is not set on Windows; the test is skipped there, but the module still loads.
const scratch = join(process.env.HOME || homedir(), '.hermes/cache/scratch')
mkdirSync(scratch, { recursive: true })

test('VallenCLI installer builds only agent and CLI, installs launcher, and uninstalls safely', { skip: process.platform === 'win32' ? 'install.sh is POSIX-only; Windows uses install.ps1' : false }, t => {
  const home = mkdtempSync(join(scratch, 'vallencli-installer-'))
  const fakeBin = join(home, 'fake-bin')
  mkdirSync(fakeBin)
  const log = join(home, 'npm.log')
  // install.sh calls `node -v` and `node -p` for the version gate.
  writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\n[ "$1" = "-v" ] && { printf "v20.19.2\\n"; exit 0; }\n[ "$1" = "-p" ] && { printf "20\\n"; exit 0; }\n')
  writeFileSync(join(fakeBin, 'npm'), '#!/bin/sh\n[ "$1" = "-v" ] && { printf "10.8.2\\n"; exit 0; }\nprintf "%s\\n" "$*" >> "$NPM_LOG"\n')
  for (const bin of ['node', 'npm']) lstatSync(join(fakeBin, bin))
  spawnSync('chmod', ['+x', join(fakeBin, 'node'), join(fakeBin, 'npm')])
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`, NPM_LOG: log }

  const installed = spawnSync('bash', [join(root, 'install.sh'), '--install-vallencli'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr || installed.stdout)

  const emperorLink = join(home, '.local/bin/vallenemperor')
  const emperorCliLink = join(home, '.local/bin/vallenemperorcli')
  assert.equal(spawnSync('readlink', ['-f', emperorLink], { encoding: 'utf8' }).stdout.trim(), join(root, 'bin/vallenemperor'))
  assert.equal(spawnSync('readlink', ['-f', emperorCliLink], { encoding: 'utf8' }).stdout.trim(), join(root, 'bin/vallenemperorcli'))

  const npmLog = readFileSync(log, 'utf8')
  assert.equal(npmLog.includes('ci --workspace=vallenagent --workspace=vallencli --include-workspace-root=false'), true)
  assert.match(npmLog, /-w vallenagent run build/)
  assert.match(npmLog, /-w vallencli run build/)
  assert.doesNotMatch(npmLog, /vallenterminal|rebuild:pty|electron/)

  const uninstalled = spawnSync('bash', [join(root, 'install.sh'), '--uninstall-vallencli'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout)
  assert.equal(spawnSync('test', ['-e', emperorLink]).status, 1)
  assert.equal(spawnSync('test', ['-e', emperorCliLink]).status, 1)
})
