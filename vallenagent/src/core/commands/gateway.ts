import { existsSync } from 'fs'
import { join } from 'path'
import { allowTelegramUser, createTelegramPairingCode, getTelegramBotInfo, revokeTelegramUser, sendTelegramNotification, setTelegramApproval, setTelegramToken, startTelegramGateway, stopTelegramGateway, restartTelegramGateway, telegramStatus } from '../../gateway/manager'
import { loadTelegramConfig } from '../../gateway/store'

export async function handleGatewayCommand(args: string[]): Promise<string> {
  const [platform = '', action = '', ...rest] = args
  if (!platform) {
    const wa = existsWhatsAppClient() ? 'WA connector ditemukan' : 'WA connector lokal belum tersedia'
    const tg = telegramStatus()
    return `[Gateway]\nWhatsApp: ${wa}\nTelegram: ${tg.running ? `aktif (PID ${tg.pid})` : tg.configured ? 'siap, belum aktif' : 'token belum diatur'}\n\nPerintah: /gateway wa | /gateway tel <token|pair|start|stop|restart|status|allow|revoke|send|approval>`
  }
  if (platform === 'wa' || platform === 'whatsapp') {
    const actionArg = action.toLowerCase()
    if (!existsWhatsAppClient()) return 'WA gateway belum tersedia di source watools (wa-client.js tidak ditemukan).'
    return actionArg === 'status'
      ? 'WA client terpasang. Untuk operasi lainnya gunakan watools/wa-client.js sesuai setup lokal.'
      : 'WA client lokal terdeteksi, tetapi integrasi daemon WA belum ditautkan ke pengelola gateway ini.'
  }
  if (!['tel', 'telegram', 'tg'].includes(platform)) return 'Pilihan tidak dikenal. Gunakan /geteway wa atau /geteway tel.'

  const sub = action.toLowerCase()
  if (!sub || sub === 'status') {
    const status = telegramStatus()
    const config = loadTelegramConfig()
    let bot = config.bot_username || 'belum diverifikasi'
    if (config.token && !config.bot_username) {
      try { bot = await getTelegramBotInfo() } catch (error) { return `${statusText(status)}\n${safeError(error)}` }
    }
    return `${statusText(status)}\nBot: ${bot}`
  }
  if (sub === 'token') {
    if (!rest[0]) return 'Penggunaan: /geteway tel token <token dari @BotFather>'
    setTelegramToken(rest[0])
    return 'Token Telegram disimpan dengan permission 0600. Nilai token disembunyikan.'
  }
  if (sub === 'pair') {
    if (!loadTelegramConfig().token) return 'Atur token Telegram dulu: /geteway tel token <token>'
    const code = createTelegramPairingCode()
    return `Kode pairing: ${code}\nBerlaku 5 menit dan hanya bisa dipakai sekali. Kirim /pair ${code} ke bot Telegram secara pribadi.`
  }
  if (sub === 'start') return startTelegramGateway().message
  if (sub === 'stop') return stopTelegramGateway().message
  if (sub === 'restart') {
    return (await restartTelegramGateway()).message
  }
  if (sub === 'allow' || sub === 'revoke') {
    const userId = Number(rest[0])
    if (!Number.isSafeInteger(userId) || userId <= 0) return `Penggunaan: /geteway tel ${sub} <numeric-user-id>`
    const changed = sub === 'allow' ? allowTelegramUser(userId) : revokeTelegramUser(userId)
    return changed ? `User ${userId} ${sub === 'allow' ? 'ditambahkan ke' : 'dihapus dari'} allowlist.` : `User ${userId} tidak berubah.`
  }
  if (sub === 'send') {
    const message = rest.join(' ').trim()
    if (!message) return 'Penggunaan: /geteway tel send <teks notifikasi>'
    const sent = await sendTelegramNotification(message)
    return `Notifikasi terkirim ke ${sent} user Telegram.`
  }
  if (sub === 'approval') {
    try {
      const mode = setTelegramApproval(rest[0] || '')
      return `Mode approval Telegram: ${mode}.`
    }
    catch (error) { return safeError(error) }
  }
  return 'Penggunaan: /geteway tel token|pair|start|stop|restart|status|allow|revoke|send|approval'
}

function statusText(status: Record<string, unknown>): string {
  return `Telegram gateway: ${status.running ? `aktif (PID ${status.pid})` : 'mati'}\nUser terdaftar: ${status.allowed_users}\nApproval: ${status.approval}${status.last_error ? `\nError terakhir: ${status.last_error}` : ''}`
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***') : 'Operasi gateway gagal.'
}

function existsWhatsAppClient(): boolean {
  return existsSync(join(process.cwd(), 'watools', 'wa-client.js'))
}
