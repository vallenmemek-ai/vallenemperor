import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm, rmdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'

const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const browserSessionBootstrap = `
import os
from contextlib import contextmanager
from playwright.sync_api import sync_playwright

@contextmanager
def browser_session(**launch_options):
    manager = sync_playwright().start()
    context = None
    try:
        launch_options.setdefault('headless', True)
        context = manager.chromium.launch_persistent_context(
            user_data_dir=os.environ.get('VALLENEMPEROR_BROWSER_PROFILE', '/tmp/vallenemperor-browser-profile'),
            **launch_options,
        )
        page = context.pages[0] if context.pages else context.new_page()
        yield page
    finally:
        if context is not None:
            context.close()
        manager.stop()
`

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Browser profile path must be a real directory')
  await chmod(path, 0o700)
}

export async function browserProfilePath(home: string, ownerSessionId: string, sessionName: string, now = Date.now()): Promise<string> {
  if (!ownerSessionId || ownerSessionId.length > 512) throw new Error('Browser profile requires a valid owner session')
  if (!SESSION_NAME.test(sessionName) || sessionName === '.' || sessionName === '..') throw new Error('Invalid browser session name')

  const root = join(home, 'browser-sessions')
  const ownerDir = join(root, createHash('sha256').update(ownerSessionId).digest('hex'))
  const current = join(ownerDir, sessionName)
  await ensurePrivateDirectory(root)
  await ensurePrivateDirectory(ownerDir)

  for (const owner of await readdir(root, { withFileTypes: true })) {
    if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name)) continue
    const ownerPath = join(root, owner.name)
    if ((await lstat(ownerPath)).isSymbolicLink()) continue
    for (const entry of await readdir(ownerPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_NAME.test(entry.name)) continue
      const path = join(ownerPath, entry.name)
      if (path === current) continue
      if (now - (await lstat(path)).mtimeMs > PROFILE_TTL_MS) await rm(path, { recursive: true, force: true })
    }
    if ((await readdir(ownerPath)).length === 0) await rmdir(ownerPath).catch(() => undefined)
  }

  await ensurePrivateDirectory(current)
  await utimes(current, now / 1000, now / 1000)
  return current
}
