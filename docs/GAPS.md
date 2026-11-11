# GAPS.md — hasil scan kekurangan & tahapan berikutnya

Dibuat `2026-11-11` dari scan nyata (bukan perkiraan). Versi saat scan: **999.999.1026**.
Registry: **38 tool**, **75 command** terdokumentasi, test **444 agent + 166 CLI**.

> Aturan centang: `[x]` hanya boleh dipasang setelah perintah pembuktian dijalankan dan
> output-nya ditempel di bagian bukti. `[ ]` = belum. Jangan centang karena "kelihatannya sudah".

---

## 1. Cara scan (bisa diulang)

```bash
# tool yang terdaftar
node -e "const r=require('./vallenagent/dist/index.js'); r.registerBuiltinTools(r.registry); \
  console.log(r.registry.list().map(t=>t.name).join(' '))"

# parameter tiap tool
node -e "const r=require('./vallenagent/dist/index.js'); r.registerBuiltinTools(r.registry); \
  console.log(JSON.stringify(r.registry.list().map(t=>({n:t.name,p:Object.keys(t.schema.parameters.properties||{})}))))"

# command terdokumentasi
node -e "const c=require('./vallenagent/dist/index.js'); console.log(c.COMMAND_REFERENCE.length)"

# tool Hermes sebagai pembanding (54 nama)
grep -oE '"([a-z][a-z0-9_]{2,40})"' ~/Destop/hermes-agent-main/toolsets.py
```

Hasil scan skill (semua `.vallenemperor/skills/**/SKILL.md`):

| Yang dicari | Hasil |
|---|---|
| Nama tool dipanggil skill tapi tidak terdaftar | `computer_use` (10×), `browser_navigate/snapshot/click/type` (1×) |
| Parameter tool dipakai skill tapi tidak ada di schema | `terminal.pty` |
| Command dipakai skill tapi tidak ada di core | tidak ada yang valid (hasilnya noise path `/dev`, `/opt`) |

**Kesimpulan metode:** skill bagus untuk menemukan gap **workflow**, lemah untuk gap **API**.
Pembanding yang produktif adalah kode Hermes langsung, bukan teks skill.

---

## 2. Gap nyata

### P0 — memblokir use case yang sudah didokumentasikan skill

- [ ] **`terminal` tidak punya `pty`.** Skill `codex`, `opencode`, `claude-code` mengorkestrasi
      TUI interaktif; tanpa pty agent harus menyuruh user pakai `tmux` manual.
      Bukti: `grep -c pty vallenagent/src/tools/builtin_tools/terminal_tools.ts` → `0`;
      schema hanya `command, workdir, timeout, background, notify`.
      Kriteria selesai: `terminal` menerima `pty: true`, jalan di Linux/macOS; di Windows
      memakai `conpty`/fallback yang jelas; ada test yang menjalankan program yang butuh TTY
      dan membuktikan output-nya bukan pipe.

- [ ] **Cron tidak bisa diubah setelah dibuat.** `schedule` hanya `list/add/remove/history`.
      `CronStore` sudah punya field `enabled` tapi tidak ada cara memakainya.
      Bukti: `grep -n "async .*(" vallenagent/src/core/cron_scheduler.ts` → add/list/history/
      remove/claimDue/complete saja.
      Kriteria selesai: aksi `update`, `pause`, `resume`, `run` (fire sekarang), `cancel`
      tersedia di tool dan `/schedule`, dengan test untuk tiap aksi.

### P1 — kurang untuk kenyamanan, tidak memblokir

- [ ] **Timeout `clarify` belum bisa diatur.** Sekarang hardcode 5 menit di `vallencli/src/cli.ts`
      (`options.clarifyTimeoutMs || 5 * 60_000`), tidak ada key config.
      Kriteria: `gateway.clarify_timeout_ms` (atau `clarify.timeout_ms`) dibaca, didokumentasikan,
      dan ada test.

- [ ] **Agent tidak bisa mengganti tema.** `saveTheme` hanya ada di CLI (`cli-theme.ts`),
      tidak ada tool. `/theme` bisa diketik user, agent tidak.
      Kriteria: tool `set_theme` (nama tema tervalidasi, hasilnya terlihat di status bar).

- [ ] **`text_to_speech` tidak ada.** Hermes punya; VallenEmperor tidak.
      Kriteria: tool dengan provider yang bisa dikonfigurasi, gagal jelas kalau tidak ada
      kredensial, dan tidak pernah mencetak key.

### P2 — opsional / perlu keputusan positioning

- [ ] **`video_analyze` / `video_generate`.** Belum ada. Perlu keputusan: masuk produk atau tidak.
- [ ] **`computer_use`.** Belum ada dan skill-nya sudah diberi banner peringatan.
      Keputusan: tambah lewat extension pack, atau hapus skill-nya dari bundel.
- [ ] **`annotate_preview` / `desktop_preview`.** Khusus desktop UI Hermes; kemungkinan besar
      tidak relevan untuk CLI.

---

## 3. Bukan gap (jangan dikerjakan)

| Item | Alasan |
|---|---|
| `browser_navigate/click/type/snapshot` | VallenEmperor sengaja memakai satu `browser_exec` serbaguna |
| `image_gen` | Sudah ada sebagai `image_generate` |
| `cronjob_manage` | Sudah ada sebagai `schedule` (yang kurang hanya aksinya — lihat P0) |
| `feishu_*`, `discord*`, `react_to_message` | Integrasi platform Hermes, di luar positioning CLI |
| `read_terminal` / `close_terminal` | `process_manage` sudah menutup poll/log/write/close/kill |
| `set_theme` sebagai *tool* | Tetap masuk P1; ini satu-satunya item UI yang masuk akal untuk agent |

---

## 4. Tahapan kerja

### Stage 1 — parity terminal (P0)
- [ ] Desain: `pty` memakai paket apa (node-pty vs spawn di pty host)
- [ ] Implementasi di `terminal_tools.ts` + platform adapter
- [ ] Test: program yang butuh TTY (mis. `python3 -c "import sys; print(sys.stdin.isatty())"`)
- [ ] Update skill `codex`/`opencode`/`claude-code`: buang instruksi tmux manual
- [ ] `npm run typecheck && npm run build && npm test` hijau + tempel angkanya

### Stage 2 — cron lifecycle (P0)
- [ ] `CronStore.update/pause/resume` + `enabled` dihormati `claimDue`
- [ ] Aksi `run` (fire sekarang tanpa mengubah jadwal) + `cancel`
- [ ] Tool `schedule` + `/schedule` memakai aksi baru
- [ ] Test per aksi + test bahwa job `paused` tidak di-claim

### Stage 3 — config & tool kecil (P1)
- [ ] `clarify_timeout_ms` di config + dokumentasi
- [ ] Tool `set_theme`
- [ ] `text_to_speech` (kalau diputuskan masuk)

### Stage 4 — keputusan P2
- [ ] Putuskan `computer_use`: extension pack atau hapus dari bundel
- [ ] Putuskan video tools

---

## 5. Bukti per item

Isi tabel ini setiap kali satu item dicentang.

| Item | Perintah | Output | Tanggal |
|---|---|---|---|
| — | — | — | — |
