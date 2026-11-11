# GAPS.md — hasil scan kekurangan & tahapan berikutnya

Dibuat `2026-11-11` dari scan nyata (bukan perkiraan). Versi saat scan: **999.999.1026**.
Registry: **40 tool**, **75 command** terdokumentasi, test **461 agent + 167 CLI**.

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

- [x] **`terminal` tidak punya `pty`.** Skill `codex`, `opencode`, `claude-code` mengorkestrasi
      TUI interaktif; tanpa pty agent harus menyuruh user pakai `tmux` manual.
      **Selesai:** `terminal` menerima `pty: true`; `resolvePty()` memakai `script -qefc`
      (util-linux, exit code anak dipropagasikan) di Linux dan BSD `script` di macOS.
      Windows mengembalikan error jelas, bukan diam-diam jalan tanpa TTY.
      Bukti: `python3 -c "import sys; print(sys.stdin.isatty())"` → `True` dengan pty,
      `False` tanpa; `exit 7` → exit_code 7.

- [x] **Cron tidak bisa diubah setelah dibuat.** `schedule` hanya `list/add/remove/history`.
      **Selesai:** `CronStore.update/setEnabled/runNow` + aksi `update`, `pause`, `resume`,
      `run` di tool `schedule` dan `/schedule`. Job `paused` tidak pernah di-claim.
      `cancel` **tidak** diimplementasi dan itu disengaja: VallenEmperor tidak punya
      registry run aktif, jadi tidak ada proses berjalan untuk dihentikan — `pause`
      adalah padanan jujurnya.
      Bukti: `vallenagent/tests/cron_lifecycle.test.mjs` (6 test) + test tool lifecycle.

### P1 — kurang untuk kenyamanan, tidak memblokir

- [x] **Timeout `clarify` belum bisa diatur.** **Selesai:** `gateway.clarify_timeout_ms`
      (default `300000`) dibaca CLI sebelum fallback 5 menit.
      Bukti: test `clarify timeout has a config default`.

- [x] **Agent tidak bisa mengganti tema.** **Selesai:** tool `set_theme` (status/set) menulis
      file `cli_theme` yang sama yang dibaca CLI saat start; nama tema divalidasi.
      Bukti: test `set_theme reports, saves and rejects unknown themes` + guard
      `core theme names match the CLI theme table`.

- [x] **`text_to_speech` tidak ada.** **Selesai:** tool `text_to_speech` memakai engine yang
      sudah ada di host (`say`, `espeak-ng`/`espeak`, `termux-tts-speak`) atau
      `tts.command` dari config. Tidak ada dependency native baru.
      Bukti: di mesin ini tidak ada engine → tool menjawab
      `No speech engine found...` (jujur), bukan gagal diam-diam.

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
| `cronjob_manage` | Sudah ada sebagai `schedule` (aksi lengkap sejak Stage 2) |
| `feishu_*`, `discord*`, `react_to_message` | Integrasi platform Hermes, di luar positioning CLI |
| `read_terminal` / `close_terminal` | `process_manage` sudah menutup poll/log/write/close/kill |

---

## 4. Tahapan kerja

### Stage 1 — parity terminal (P0) — SELESAI
- [x] Desain: tanpa native module, pakai `script` (util-linux / BSD)
- [x] Implementasi `resolvePty()` di `core/platform.ts` + `pty` di `terminal_tools.ts`
- [x] Test: `terminal_pty.test.mjs` (isatty True vs False, exit code, kombinasi terlarang)
- [x] Update skill `codex`/`opencode`/`claude-code`: pakai `pty: true` lagi

### Stage 2 — cron lifecycle (P0) — SELESAI
- [x] `CronStore.update/setEnabled/runNow` + `enabled` dihormati `claimDue`
- [x] Aksi `update`, `pause`, `resume`, `run` di tool `schedule` + `/schedule`
- [x] Test: `cron_lifecycle.test.mjs` (6 test, termasuk job paused tidak di-claim)
- [x] `cancel` dinyatakan tidak berlaku (tidak ada registry run aktif)

### Stage 3 — config & tool kecil (P1) — SELESAI
- [x] `gateway.clarify_timeout_ms` + dokumentasi
- [x] Tool `set_theme` + guard daftar tema
- [x] Tool `text_to_speech` (auto-detect, tanpa dependency baru)

### Stage 4 — keputusan P2
- [ ] Putuskan `computer_use`: extension pack atau hapus dari bundel
- [ ] Putuskan video tools

---

## 5. Bukti per item

| Item | Perintah | Output | Tanggal |
|---|---|---|---|
| pty ada | `node --test tests/terminal_pty.test.mjs` | 5 pass, `isatty` True vs False | 2026-11-11 |
| cron lifecycle | `node --test tests/cron_lifecycle.test.mjs` | 6 pass | 2026-11-11 |
| clarify timeout | `node --test tests/stage3_tools.test.mjs` | `clarify timeout has a config default` pass | 2026-11-11 |
| set_theme | `registry.execute('set_theme',{action:'set',name:'matrix'})` | `{"action":"set","theme":"matrix",...}` | 2026-11-11 |
| text_to_speech | `registry.execute('text_to_speech',{text:'halo'})` | `No speech engine found...` (mesin ini) | 2026-11-11 |
| suite penuh | `npm test` | **461 agent + 167 CLI**, 0 gagal | 2026-11-11 |
