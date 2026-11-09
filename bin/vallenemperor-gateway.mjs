#!/usr/bin/env node
import { createRequire } from 'node:module'
import { emitKeypressEvents } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'vallenagent/package.json'))
const gateway = require(join(root, 'vallenagent/dist/gateway/manager.js'))

function readHiddenToken() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Token entry requires an interactive terminal; no token was read.')
  return new Promise((resolve, reject) => {
    let token = ''
    const input = process.stdin
    const finish = (error, value = '') => {
      input.removeListener('keypress', onKey)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
      error ? reject(error) : resolve(value)
    }
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Token entry cancelled.'))
      if (key.name === 'return' || key.name === 'enter' || text === '\r' || text === '\n') return finish(null, token)
      if (key.name === 'backspace') { token = Array.from(token).slice(0, -1).join(''); return }
      if (text && !key.ctrl && token.length + text.length <= 256) token += text
    }
    input.setRawMode(true)
    emitKeypressEvents(input)
    input.on('keypress', onKey)
    input.resume()
    process.stdout.write('Bot token (input hidden): ')
  })
}

async function main(action) {
  if (action === 'token') {
    let token = await readHiddenToken()
    try { gateway.setTelegramToken(token) } finally { token = '' }
    console.log('Telegram bot token saved with owner-only file permissions.')
    return
  }
  if (action === 'pair') {
    if (!gateway.telegramStatus().configured) throw new Error('Set bot token first.')
    const code = gateway.createTelegramPairingCode()
    console.log(`Pairing code: ${code}\nSend /pair ${code} to your bot privately. Code expires in five minutes.`)
    return
  }
  if (action === 'start') {
    console.log(gateway.startTelegramGateway().message)
    return
  }
  if (action === 'stop') {
    console.log(gateway.stopTelegramGateway().message)
    return
  }
  if (action === 'status') {
    const status = gateway.telegramStatus()
    console.log(`Telegram Gateway\nConfigured: ${status.configured ? 'yes' : 'no'}\nRunning: ${status.running ? 'yes' : 'no'}\nPID: ${status.pid || 'none'}\nPaired users: ${status.allowed_users}\nApproval: ${status.approval}`)
    return
  }
  if (action === 'help') {
    console.log('Create bot with @BotFather; set token, pair your private account, then start. Use status/stop anytime.')
    return
  }
  throw new Error('Unknown Telegram action. Use token, pair, start, stop, status, or help.')
}

try {
  await main(process.argv[2] || 'help')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Telegram Gateway action failed.')
  process.exitCode = 1
}
