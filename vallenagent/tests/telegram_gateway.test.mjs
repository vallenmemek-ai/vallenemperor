import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Telegram gateway behaviour, driven through an injected HTTP client:
 * pairing, allowlist enforcement, rate limiting and inline approvals.
 * No network: every API call is answered by the stub below.
 */

const home = mkdtempSync(join(tmpdir(), 'vallenemperor-telegram-'))
process.env.VALLENEMPEROR_HOME = home

const { TelegramAdapter } = await import('../dist/gateway/telegram.js')

test.after(() => rmSync(home, { recursive: true, force: true }))

const configPath = () => {
  const dir = join(home, 'gateway')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'telegram.json')
}

function seedConfig(overrides = {}) {
  writeFileSync(configPath(), JSON.stringify({ token: 'test-token', allowlist: [], ...overrides }), 'utf8')
}

const readConfig = () => JSON.parse(readFileSync(configPath(), 'utf8'))
const codeHash = code => createHash('sha256').update(code).digest('hex')

function fakeHttp() {
  const calls = []
  return {
    calls,
    sentTexts: () => calls.filter(call => call.method === 'sendMessage').map(call => String(call.payload.text)),
    async post(url, payload) {
      const method = url.split('/').pop()
      calls.push({ url, method, payload })
      if (method === 'sendMessage') return { data: { ok: true, result: { message_id: calls.length } } }
      return { data: { ok: true, result: true } }
    },
    async get() { return { data: Buffer.alloc(0), headers: {} } }
  }
}

function fakeRouter() {
  const queued = []
  return { queued, enqueue: (...args) => { queued.push(args); return true } }
}

const privateMessage = (userId, text) => ({ chat: { id: userId, type: 'private' }, from: { id: userId }, text })

function makeAdapter({ http = fakeHttp(), router = fakeRouter() } = {}) {
  return { adapter: new TelegramAdapter({ http, router }), http, router }
}

test('a valid pairing code adds the user to the allowlist and clears the code', async () => {
  seedConfig({ pairing: { code_hash: codeHash('123456'), expires_at: Date.now() + 60_000, attempts: 0 } })
  const { adapter, http } = makeAdapter()

  await adapter.handleMessage(privateMessage(42, '/pair 123456'))

  const config = readConfig()
  assert.deepEqual(config.allowlist, [42])
  assert.equal(config.pairing, undefined, 'the pairing code is single use')
  assert.match(http.sentTexts().join('\n'), /berhasil dipasangkan/)
})

test('a wrong pairing code counts an attempt and does not grant access', async () => {
  seedConfig({ pairing: { code_hash: codeHash('123456'), expires_at: Date.now() + 60_000, attempts: 0 } })
  const { adapter, http } = makeAdapter()

  await adapter.handleMessage(privateMessage(42, '/pair 000000'))

  const config = readConfig()
  assert.deepEqual(config.allowlist, [])
  assert.equal(config.pairing.attempts, 1)
  assert.match(http.sentTexts().join('\n'), /Kode salah\. Sisa percobaan: 4/)
})

test('five wrong attempts burn the pairing code', async () => {
  seedConfig({ pairing: { code_hash: codeHash('123456'), expires_at: Date.now() + 60_000, attempts: 4 } })
  const { adapter, http } = makeAdapter()

  await adapter.handleMessage(privateMessage(42, '/pair 000000'))

  assert.equal(readConfig().pairing, undefined)
  assert.match(http.sentTexts().join('\n'), /hangus setelah 5 percobaan/)
})

test('an expired or missing pairing code is refused with a clear message', async () => {
  seedConfig({ pairing: { code_hash: codeHash('123456'), expires_at: Date.now() - 1, attempts: 0 } })
  const { adapter, http } = makeAdapter()

  await adapter.handleMessage(privateMessage(42, '/pair 123456'))

  assert.deepEqual(readConfig().allowlist, [])
  assert.match(http.sentTexts().join('\n'), /tidak ada atau sudah kedaluwarsa/)
})

test('a user outside the allowlist cannot enqueue work', async () => {
  seedConfig({ allowlist: [7] })
  const { adapter, router, http } = makeAdapter()

  await adapter.handleMessage(privateMessage(42, 'jalankan perintah'))

  assert.equal(router.queued.length, 0, 'no turn is queued for an unpaired user')
  assert.equal(http.sentTexts().length, 0, 'and no reply is leaked back')
})

test('an allowlisted user message is queued for the agent', async () => {
  seedConfig({ allowlist: [42] })
  const { adapter, router } = makeAdapter()

  await adapter.handleMessage(privateMessage(42, '  halo  '))

  assert.equal(router.queued.length, 1)
  const [userId, text, transport, imagePath] = router.queued[0]
  assert.equal(userId, 42)
  assert.equal(text, 'halo')
  assert.equal(transport, adapter)
  assert.equal(imagePath, undefined)
})

test('group chats and forged chat ids are ignored', async () => {
  seedConfig({ allowlist: [42] })
  const { adapter, router } = makeAdapter()

  await adapter.handleMessage({ chat: { id: -100, type: 'group' }, from: { id: 42 }, text: 'halo' })
  await adapter.handleMessage({ chat: { id: 99, type: 'private' }, from: { id: 42 }, text: 'halo' })

  assert.equal(router.queued.length, 0)
})

test('the rate limit drops messages after 20 in a minute', async () => {
  seedConfig({ allowlist: [42] })
  const { adapter, router } = makeAdapter()

  for (let index = 0; index < 25; index++) await adapter.handleMessage(privateMessage(42, `pesan ${index}`))

  assert.equal(router.queued.length, 20, 'only the first 20 messages in the window are queued')
})

test('an inline approve callback resolves the pending approval', async () => {
  seedConfig({ allowlist: [42] })
  const { adapter, http } = makeAdapter()

  const approved = adapter.approve(42, 42, 'jalankan rm -rf build?')
  const sent = http.calls.find(call => call.method === 'sendMessage')
  const callbackData = sent.payload.reply_markup.inline_keyboard[0][0].callback_data
  assert.match(callbackData, /^approve:/)

  await adapter.handleCallback({ id: 'cb-1', from: { id: 42 }, data: callbackData })

  assert.equal(await approved, true)
  assert.ok(http.calls.some(call => call.method === 'answerCallbackQuery'), 'the button press is acknowledged')
})

test('a deny callback resolves false, and non-allowlisted users cannot answer', async () => {
  seedConfig({ allowlist: [42] })
  const { adapter, http } = makeAdapter()

  const approved = adapter.approve(42, 42, 'hapus file?')
  const sent = http.calls.find(call => call.method === 'sendMessage')
  const denyData = sent.payload.reply_markup.inline_keyboard[0][1].callback_data.replace('deny:', 'approve:')

  await adapter.handleCallback({ id: 'cb-2', from: { id: 999 }, data: denyData })
  assert.equal(await Promise.race([approved, Promise.resolve('still-pending')]), 'still-pending', 'a stranger cannot approve')

  await adapter.handleCallback({ id: 'cb-3', from: { id: 42 }, data: denyData.replace('approve:', 'deny:') })
  assert.equal(await approved, false)
})
