/**
 * Ringkasan berjenjang (hierarchical compaction).
 *
 * `buildSummaryLines` di conversation_compaction.ts meringkas tanpa LLM: cepat dan murah,
 * tapi detail hilang — agent "lupa" langkah lama dan mengulang pekerjaan. Modul ini
 * menambahkan jalur LLM opsional: blok lama dikirim ke model murah lewat `summarize` yang
 * disuntikkan pemanggil.
 *
 * Kalau `summarize` tidak tersedia atau gagal, pemanggil tetap pakai jalur lokal — jadi
 * perilaku lama dipertahankan.
 */

export interface SummarizeRequest {
  /** Teks ringkasan/blok lama yang akan dipadatkan. */
  content: string
  /** Batas karakter hasil ringkasan. */
  maxChars: number
  /** Sinyal abort turn supaya ringkasan ikut berhenti kalau user menekan stop. */
  signal?: AbortSignal
}

export type SummarizeFn = (request: SummarizeRequest) => Promise<string | null>

/** Bersihkan keluaran model: buang pagar kode dan rapikan ke batas karakter. */
export function normalizeSummary(raw: string, maxChars: number): string | null {
  const text = String(raw || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  if (!text) return null
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** Ringkas satu blok; null berarti pemanggil harus jatuh balik ke jalur lokal. */
export async function summarizeBlocks(content: string, maxChars: number, summarize: SummarizeFn, signal?: AbortSignal): Promise<string | null> {
  try {
    const raw = await summarize({ content, maxChars, signal })
    if (raw == null) return null
    return normalizeSummary(raw, maxChars)
  } catch {
    return null
  }
}
