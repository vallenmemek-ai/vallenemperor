# wiring.md — menyatukan command CLI dengan core

Tujuan: satu perilaku per command, di semua surface. CLI hanya boleh punya command yang
memang butuh state CLI (readline, approval, theme, shell, output buffer).

Aturan main: `[x]` hanya dicentang kalau ada bukti perintah/test yang dijalankan.

## Temuan audit (dengan bukti source)

`core/commands.ts` punya dua blok:
1. blok channel-agnostic (`/mcp`, `/context`, `/compact`, `/project`, `/init`, `/checkpoints`,
   `/diff`, `/undo`, `/gateway`, `/schedule`, `/memory`, `/review`, `/help`)
2. blok **remote-only**: `if (ctx.channel !== 'remote') return NOT_HANDLED` lalu `/stop`,
   `/status`, `/new`, `/reset`, `/model`, `/sessions`, `/resume`

Karena blok 2 tidak melayani channel `terminal`, `vallencli/src/cli-commands.mjs` menduplikasi
logika itu. Duplikasi itulah sumber 6 divergensi:

| # | Command | CLI (sebelum) | Core (sebelum) | Masalah |
|---|---|---|---|---|
| 1 | `/review <fokus>` | `requestBackgroundReview({...})` — fokus dibuang | `requestBackgroundReview(cb, focus)` | fokus hilang |
| 2 | `/resume <id>` | hanya nomor, id ditolak | hanya id | bentuk core diblokir |
| 3 | `/model` | `setModel(v)` → persist `true` | `setModel(m, false)` | nama sama, efek beda |
| 4 | `/status` `/stats` | output kaya (CLI) | satu baris (remote) | dua isi |
| 5 | `/sessions` | semua, 20, bernomor | prefix, 10, polos | dua isi |
| 6 | `/new` `/reset` | `resetSession()` | `resetSession(prefix+ts)` | id sesi beda pola |

## Pekerjaan

### Fase 1 — pindahkan logika ke core (channel-agnostic)
- [x] `sessionPrefix` dihitung sekali: `ctx.sessionPrefix ?? (remote ? tg-<id>- : '')`
- [x] `/status` + `/stats` (alias) diangkat ke blok bersama, output kaya (session, model,
      provider, cwd, context, turns, skills, MCP ready/total)
- [x] `/model` diangkat: default **sesi saja** (`persist=false`), tambah `/model save <name>`
      untuk permanen
- [x] `/sessions` diangkat: filter prefix, maksimal 20, bernomor + model
- [x] `/resume` diangkat: terima **nomor atau id**
- [x] `/new` + `/reset` diangkat: `resetSession(prefix + Date.now())`, di-`await`
- [x] hapus salinan remote yang lama supaya tidak ada dua implementasi

### Fase 2 — CLI berhenti menduplikasi
- [x] hapus handler lokal: `/model`, `/status`, `/stats`, `/sessions`, `/resume`, `/new`,
      `/reset`, `/memory` (semua jatuh ke `core.handleCommand`)
- [x] `/review` tetap lokal (butuh callback live) tapi **fokus diteruskan**
- [x] `runCli` memanggil `refreshStatus()` setiap kali command bersama ditangani, supaya
      status bar ikut update tanpa handler lokal
- [x] `HELP` diperbarui: `/model save`, `/resume <nomor|id>`, `/memory [add|replace|remove]`

### Fase 3 — penjaga drift
- [x] test core: `/status`/`/stats` identik, `/model` sesi vs save, `/sessions` bernomor,
      `/resume` nomor→id dan id langsung, `/new` pakai prefix
- [x] test CLI statis: `cli-commands.mjs` **tidak boleh** lagi punya handler untuk command
      yang sudah pindah ke core; dan masih punya yang CLI-only
- [x] `now.md` ditautkan ke file ini

### Fase 4 — audit kedua (temuan lanjutan)
- [x] **`/schedule` di terminal** dulu menjawab "dikelola lewat Telegram" padahal `CronStore`
      itu lokal. Sekarang `list`/`history`/`add`/`remove` jalan di terminal; `delivery` =
      `local` untuk terminal, `telegram` untuk remote.
- [x] **10 import langsung ke `vallenagent/dist/*.js`** (`session_search`, `skill_history`,
      `skill_stats`, `skills_hub_*`, `skills_sync`) dihapus. Semua sudah diekspor barrel
      `dist/index.js`, jadi CLI sekarang lewat objek `core` — tidak lagi bergantung pada
      layout file internal.
- [x] **`/output` dan `/schedule` tidak ada di dropdown** (padahal handler-nya ada) →
      ditambahkan beserta kategorinya. Alias `/status`, `/context`, `/reset`, `/pty`,
      `/themes`, `/quit` sudah terwakili lewat `aliases`.
- [x] **`-p "/skills"` menjawab "Unknown command"** padahal command itu ada di REPL.
      Sekarang: "`/skills` hanya tersedia di REPL interaktif" (exit 2), dan command yang
      benar-benar tidak dikenal tetap "Unknown command".
- [x] Test penjaga tambahan: `cli-commands.mjs` tidak boleh menyentuh `vallenagent/dist/`,
      dan dropdown harus memuat `/output`, `/schedule`, `/status`, `/context`.

## Fase 5 — jalur remote + jadwal + review

- [x] **Budget review salah hitung.** `onTelemetry` melaporkan ukuran prompt **per panggilan**,
      dan tiap iterasi mengirim ulang seluruh percakapan — jadi konteks yang sama ditagih
      berkali-kali dan 20k terlampaui setelah dua panggilan. Sekarang yang ditagih hanya
      **pertumbuhan** (`promptTokens - promptTokensSebelumnya`). Bukti: review sungguhan
      tercatat `no-op`, bukan `error`.
- [x] **Budget habis bukan error.** Dulu `throw` → `Review error: ...`. Sekarang
      mengembalikan penanda `Review budget reached (n/limit tokens)` dan dicatat sebagai
      `skipped`.
- [x] **Approval Telegram ditulis dua kali** (daemon untuk cron, router untuk chat) dengan
      teks dan batas preview berbeda → satu `createRemoteApprovalGate()` untuk keduanya.
- [x] **Job `/schedule` dari terminal tidak pernah jalan.** `authorize` mensyaratkan
      `job.ownerId` + allowlist Telegram, sedangkan job terminal tidak punya owner. Sekarang
      job `local` dijalankan daemon, hasil ditulis ke `gateway/cron-local.log`; tool berisiko
      ditolak karena tidak ada manusia yang bisa meng-approve.
- [x] **`whatsapp` ditawarkan sebagai tujuan jadwal padahal tidak ada adapter**
      (`manager.ts` → `available: false`). Job dibuat lalu gagal tiap run. Sekarang ditolak
      saat dibuat dengan pesan yang jelas.
- [x] **Tool `schedule` bisa membuat job Telegram tanpa owner** → tidak akan pernah terkirim.
      Sekarang tool itu hanya bisa membuat job `local` dan menyebutkan alasannya.
- [x] **`/geteway` (typo) dipakai di teks bantuan** → diganti `/gateway` (nama lama tetap
      diterima sebagai alias).
- [x] **Pipeline cron dipindah ke `gateway/cron_actions.ts`** supaya bisa diuji tanpa token
      Telegram — sekaligus menghapus `void main()` yang membuat daemon mustahil diimpor.

## Fase 6 — satu referensi perintah, satu /review

- [x] **`/help` punya dua sumber.** REPL memakai `HELP` dari `cli-ui.mjs` (70 baris, Inggris,
      plus flag), sedangkan `-p "/help"` memakai `terminalHelp` di core (17 baris, Indonesia,
      tanpa `/schedule`, `/output`, `/todos`, dan lain-lain). Sekarang satu
      `COMMAND_REFERENCE` di core (42 perintah, berkelompok) yang dirender oleh:
      `/help` di REPL, `-p "/help"`, dan `--help`. Handler `/help` di CLI dihapus.
- [x] **`/review` ditangani dua kali.** REPL punya handler sendiri (meneruskan `focus` +
      callbacks), core punya versi lain. Sekarang core yang punya, dan CLI hanya mengirim
      `reviewCallbacks` lewat `CommandContext` supaya hasil review tetap tampil di REPL.
- [x] **`/settings` dan `/gateway` punya handler tapi tidak ada di dropdown** → ditambahkan.
- [x] Penjaga baru: setiap perintah di dropdown **wajib** ada di `COMMAND_REFERENCE`, dan
      `COMMAND_REFERENCE` **wajib** muncul utuh di teks `/help`.

### Bukti uji Fase 6

`2026-11-09T18:55Z`

| Uji | Perintah | Hasil |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ bersih |
| Test core | `node ../scripts/run-tests.mjs tests` | ✅ **296 pass, 0 fail** |
| Test CLI | `node ../scripts/run-tests.mjs tests` | ✅ **82 pass, 0 fail** |
| Node 24 | `npx -y node@24.22.1 ../scripts/run-tests.mjs tests` | ✅ 296 + 82, 0 fail |
| `/help` konsisten | `-p "/help"` vs REPL `/help` vs `--help` | ✅ teks referensi identik (61 baris) |
| `/review` tunggal | `grep "cmd === '/review'" cli-commands.mjs` | ✅ 0 (dulu ada handler duplikat) |
| `/review log` | `-p "/review log"` | ✅ riwayat tampil |
| Dropdown lengkap | test `command_wiring` | ✅ 34 perintah, semua terdokumentasi |

### Bukti uji Fase 5

`2026-11-09T18:20Z`

| Uji | Perintah | Hasil |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ bersih |
| Test core | `node ../scripts/run-tests.mjs tests` | ✅ **296 pass, 0 fail** |
| Test CLI | `node ../scripts/run-tests.mjs tests` | ✅ **78 pass, 0 fail** |
| Review sungguhan | `requestBackgroundReview(...)` | ✅ log `no-op`, **bukan** `error` |
| Job lokal jalan | test `cron_actions` (pakai `createCronActions` produksi) | ✅ `succeeded`, hasil masuk `cron-local.log` |
| Slash di job | prompt `/help` | ✅ perintah dijalankan, model **tidak** dipanggil |
| Job lokal + tool berisiko | `rm -rf /tmp/x` | ✅ ditolak (`false`), tak ada approver |
| Job Telegram non-allowlist | owner 999 | ✅ `denied`, tanpa prompt/ kirim |
| `/schedule add` lokal | `-p "/schedule add 0 9 * * * Asia/Jakarta \| nightly \| /status"` | ✅ dibuat + menyebut lokasi log |
| `delivery: whatsapp` | `store.add(...)` | ✅ ditolak: "WhatsApp has no adapter yet" |

### Bukti uji Fase 1–4

`2026-11-09T17:45Z`, semua perintah nyata.

| Uji | Perintah | Hasil |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ bersih |
| Test core | `node ../scripts/run-tests.mjs tests` (vallenagent) | ✅ **280 pass, 0 fail** |
| Test CLI | `node ../scripts/run-tests.mjs tests` (vallencli) | ✅ **78 pass, 0 fail** |
| Import dist di CLI | `grep -c "vallenagent/dist/" cli-commands.mjs` | ✅ **0** (dulu 10) |
| `/status` | `vallenemperor -p "/status"` | ✅ 6 baris laporan (Session/Model/Provider/cwd/Context/Turns·Skills·MCP) |
| `/sessions` | `vallenemperor -p "/sessions"` | ✅ bernomor `1. … 2. …` |
| `/model` | `vallenemperor -p "/model"` | ✅ tampil model + dua bentuk (`/model`, `/model save`) |
| `/resume <id>` | `vallenemperor -p "/resume session-…"` | ✅ `Sesi … dilanjutkan` — dulu **ditolak** CLI |
| `/resume <nomor>` | `vallenemperor -p "/resume 1"` | ✅ resolve ke id yang sama |
| `/resume 999` | `vallenemperor -p "/resume 999"` | ✅ `Nomor sesi di luar rentang` |
| `/schedule list` | `vallenemperor -p "/schedule list"` | ✅ `Belum ada jadwal.` — dulu "pakai Telegram" |
| `/skills` di `-p` | `vallenemperor -p "/skills"` | ✅ `hanya tersedia di REPL interaktif`, exit 2 |
| `/zzz-nope` | `vallenemperor -p "/zzz-nope"` | ✅ `Unknown command`, exit 2 |
| `--json` tetap jalan | `vallenemperor --json -p "/status"` | ✅ objek telemetry |


## Perilaku yang berubah (disengaja)

- `/model <nama>` sekarang **sesi saja**; permanen lewat `/model save <nama>`. Dulu CLI
  menulis `config.json` tanpa bilang-bilang, sementara Telegram tidak.
- `/resume` menerima nomor **atau** id di semua surface.
- `/status` dan `/stats` identik; Telegram ikut mendapat laporan lengkap (bukan satu baris).
- `/review <fokus>` benar-benar meneruskan fokusnya.

