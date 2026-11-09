import type { Message } from '../providers/providers'
import { SUMMARY_HEADER, stripTurnProgress } from './conversation_compaction'

export function isTaskExecutionRequest(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || /^(?:how|what|why|when|where|which|who|explain|compare|summarize|translate|gimana|kenapa|mengapa|apa|jelaskan|bandingkan|ringkas|should i|should we|can you explain)\b/i.test(normalized)) return false
  // A question is not an execution request, even when it happens to contain an action verb
  // ("biar enak gw update"). Indonesian question markers are explicit: -kah, apa, kenapa,
  // gimana, saran, pendapat, menurut lu.
  if (/(?:^|[^a-z0-9])kah(?:$|[^a-z0-9])|\b(?:apakah|apa|kenapa|mengapa|gimana|bagaimana|saran|sarannya|pendapat|menurut (?:lu|lo|kamu|anda))\b/i.test(normalized)) return false
  return /\b(?:fix|repair|implement|build|create|write|edit|refactor|debug|verify|update|remove|delete|install|configure|deploy|finish|complete|kerjain|benerin|perbaiki|buat|tambah|tambahkan|ubah|hapus|jalankan|verifikasi|selesaikan|lanjut|terus|continue|keep going|gas|gasin)\b/i.test(normalized) || /\b(?:run (?:the )?(?:tests?|suite|build|typecheck)|test (?:the )?(?:suite|tests|change|feature|implementation|project))\b/i.test(normalized)
}

export function isContinuationRequest(text: string): boolean {
  return /^(?:lanjut|terus|continue|keep going|go on|carry on|gas|gasin)\b/i.test(text.trim())
}

export function previousTaskGoal(history: Message[], current: string): string {
  if (!isContinuationRequest(current)) return current
  const previous = [...history].reverse().find(message => message.role === 'user' &&
    !message.content.startsWith(SUMMARY_HEADER) && !isContinuationRequest(message.content))
  return previous ? stripTurnProgress(previous.content) : current
}
