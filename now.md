# now.md — status pekerjaan

Terakhir diperbarui: `2026-11-09T16:50Z` · HEAD setelah commit "tool_call health gate"
· rilis publik `vallenemperor@999.999.999` (versi publik itu **belum** memuat bagian 3 & 4)

Cara baca: `[x]` = selesai **dan sudah diuji**, `[ ]` = belum. Jangan centang tanpa bukti
perintah yang benar-benar dijalankan — itu aturan mainnya.

---

## 1. Cross-platform CLI (selesai, terbit)

- [x] Adapter platform tunggal `vallenagent/src/core/platform.ts` — `resolveShell`, `wrapCommand`,
      `killTree`, `resolvePython`, `chmodSafe`, `spawnableCommand`, `interactiveShell`,
      `shellDialectPrompt`, `isTermux`, `platformSummary`
- [x] `session_search` load `better-sqlite3` lazy + fallback `legacySearch` (core tidak crash lagi)
- [x] `better-sqlite3` → `optionalDependencies` (root + vallenagent), lock file di-regenerate
- [x] `terminal` / `process_manage` / `execute_code`: gate `win32` dihapus, shell per-host,
      probe cwd per-shell (`__VALLEN_CWD__`), `killTree` ganti `process.kill(-pid)`
- [x] `browser_exec`: `python3` hardcode → `resolvePython()`
- [x] `cli.mjs`: `readHiddenToken` pakai raw-mode keypress (bukan `stty`), `enterShell` per-OS,
      versi dibaca dari `package.json` root
- [x] `gateway/manager.ts` + `mcp/manager.ts`: `taskkill`, `spawnableCommand` untuk shim `.cmd`
- [x] Approval Windows: `del /s`, `rd /s`, `format`, `reg delete`, `Remove-Item -Recurse -Force`,
      `Stop-Process -Force`, `iwr|iex`, `set-executionpolicy`, `SENSITIVE_ROOTS` Windows
- [x] Tokenizer shell tidak lagi menganggap `\` sebagai escape di Windows
- [x] System prompt menyebut dialect shell aktif
- [x] `chmodSync` → `chmodSafe` di 15 file; path `~/.vallenemperor` disatukan ke `getVallenHome()`
- [x] Launcher `bin/vallenemperor` + `bin/vallenemperorcli` jadi Node, plus `.cmd` untuk Windows
- [x] `install.sh` Termux-aware (`$PREFIX/bin`, preflight node≥20), `install.ps1` untuk Windows
- [x] Conhost lama → ASCII + no-color otomatis
- [x] README: tabel platform + catatan Termux/Windows
- [x] CI matrix ubuntu/windows/macos + job tanpa native module + smoke test `npm install -g .`
- [x] `scripts/run-tests.mjs` — daftar file eksplisit (Node 24 tidak menerima argumen direktori,
      cmd.exe tidak expand glob)
- [x] Versi `999.999.999` lolos `npm publish`, sudah **publik** (`dist-tags.latest`)
- [x] Verifikasi install dari registry bersih: `npm install -g vallenemperor` →
      `vallenemperor v999.999.999`, `config show` exit 0
- [x] 3 commit ter-push (`ahead=0 behind=0`)

---

## 2. Hasil audit laporan kejujuran (`ujikejujuran/keluhanagent.md`)

Laporan itu dijalankan `2026-11-09T13:42:27Z` terhadap install global **0.1.1** (belum ada commit
kita). Setiap klaim sudah dicek ulang ke source + build sekarang.

| Klaim | Status | Bukti |
|---|---|---|
| H1 — `-p` tidak mem-parse slash command | ✅ benar | `-p "/help"` → model mengarang daftar sendiri, tidak ada parser CLI |
| H2 — `/stats` beda arti antar jalur | ✅ benar | konsekuensi H1: interaktif lewat `localCommand`, `-p` langsung ke LLM |
| H5 — `--approval off/dangerous/all` semuanya meloloskan `rm -rf` | ✅ benar, bug nyata | `agent.ts:349` hanya memasang gate jika `surface.requestApproval` ada; `runOneShot()` memanggil `runTurn(..., {})` |
| H4 — exit code selalu 0 | 🟡 sebagian | `main()` mengembalikan 1 hanya bila `completionStatus === 'incomplete'` |
| H8 — banner + WARN tiap run, output `-p` kotor | ❌ salah untuk `-p` | `-p "Reply with exactly: PONG"` → output persis `PONG`, exit 0 |
| TS-F1 — 7 tool deferred | ✅ benar | `tools.ts:133` `DEFERRED_TOOLS` tepat 7 nama |
| TS-F2/F5/F6 — tidak ada `list_dir`/`glob`/`git`/`checkpoint`/`typecheck`/`cron` | ✅ benar | grep `name:` di `src/tools/` → nol hasil |
| TS-F3 — `search_files` skip dotfile | ❌ salah | tidak ada filter dotfile; `~` di-expand di `file_tools.ts:469` |
| C1 — dua agent tabrakan tanpa lock | ✅ benar by design | tidak ada lock / `expected_hash` di `patch` |
| A1/A2 — patch wajib full-read | ✅ benar by design | kontrak di source |
| B-F1 — nama binary ambigu (`vallen`/`vallenatrix`/`hermes`) | 🟡 bukan masalah paket | `bin` kita hanya `vallenemperor` + `vallenemperorcli` |

Skor: **7 benar · 1 sebagian · 2 salah · 1 salah alamat.**

---

## 3. Mode one-shot (`-p`) — selesai

Dikerjakan setelah audit. Tiga bug yang semuanya bermuara ke "flag kelihatan bekerja
padahal tidak".

- [x] **Approval gate hilang di `-p`.** `runOneShot()` mengirim `{}` sebagai callback, jadi
      `onBeforeTool` tidak pernah dipasang dan `--approval all|dangerous|off` identik.
      Sekarang `createOneShotApproval()` memasang gate: tool berisiko **ditolak** (bukan
      dijalankan diam-diam), pesan ke stderr, dan run keluar non-zero.
- [x] **`--approval <mode>` tidak pernah dipakai.** `main()` menulis `config.approval`,
      sementara semua permukaan membaca `config.agentApproval`. Flag jadi mati di kedua mode.
      Sekarang `applyRuntimeOverrides()` menyinkronkan keduanya.
- [x] **`config set approval <mode>` juga mati** (menyimpan key `approval`). Sekarang menulis
      `agentApproval`, dan `config show` menampilkan mode aktif.
- [x] **Slash command di `-p` diteruskan ke LLM.** `/help`, `/exit`, command ngawur semuanya
      dijawab model dengan karangan. Sekarang `isSlashCommandLine()` + `runOneShotCommand()`
      men-dispatch handler asli: `/help` → help CLI, `/exit` → keluar, sisanya lewat
      `core.handleCommand`, unknown → stderr + exit 2.
- [x] **Exit code.** Non-zero bila turn `incomplete` **atau** ada tool yang diblokir.
- [x] Test regresi `vallencli/tests/oneshot.test.mjs` (12 test).
- [x] Dokumentasi: `HELP` + README menjelaskan `-p` menolak tool berisiko kecuali
      `--approval off`.

Bukti uji (perintah nyata, cwd `/tmp`):

```text
-p "/help"                     → help CLI asli, exit 0        (dulu: model mengarang)
-p "/exit"                     → "Session ending.", exit 0     (dulu: model mengarang)
-p "/zzz-not-a-command-999"    → "Unknown command: ...", exit 2
--approval dangerous -p "...git clean -n"
                               → Blocked risky tool "terminal" ... exit 1
--approval off -p "...git clean -n"
                               → perintah jalan, exit 0
```

Catatan trade-off: memasang `requestApproval` membuat agent menonaktifkan eksekusi tool
paralel (`canParallelize: !callbacks?.onBeforeTool`), jadi batch tool di `-p` sekarang
berurutan. Itu harga dari punya gate; mode interaktif sudah begitu dari awal.

Catatan rilis: `999.999.999` yang sudah publik **tidak** memuat perbaikan di atas. Semver
tidak punya batas atas — `npm version major` dari `999.999.999` menghasilkan `1000.0.0` dan
itu valid. Jadi rilis berikutnya:

```bash
npm version major --no-git-tag-version   # 999.999.999 -> 1000.0.0
./scripts/release.sh current
```

Koreksi: klaim sebelumnya bahwa `999.999.999` adalah versi tertinggi semver itu **salah**.


---

## 4. Telemetry & permukaan tool — selesai

> Penyatuan command CLI ↔ core dilacak terpisah di [`wiring.md`](wiring.md).

### P1
- [x] **`--json`** untuk telemetry. `core.contextTelemetry(agent)` jadi satu sumber data;
      `--json -p "/stats"` mencetak satu objek JSON stabil (session, model, token, persen,
      turns, skills). Command lain dibungkus `{command, handled, response}`.
- [x] **`--quiet` / `--no-banner`.** Startup box + health probe + status line non-interaktif
      semuanya dilewati. Diverifikasi: `printf '/exit\n' | vallenemperor --quiet` → output kosong.

### P2 — permukaan tool
- [x] **`list_dir`** (tool baru, total tool 28 → 30). Daftar direktori terstruktur, dirs dulu,
      filter glob, `recursive` + `depth`, `include_hidden`, `limit`. Read-only, parallel-safe.
- [x] **`typecheck`** (tool baru). Men-dispatch `captureTypeScriptDiagnostics` yang sudah ada di
      core tapi belum punya wrapper. Mengembalikan `ok`, `errors`, `warnings`, `files_checked`,
      daftar diagnostik per file — tanpa shell. Kalau tidak ada `tsconfig.json`, error-nya jelas.
- [x] **`expected_hash` di `patch`.** `read_file` sekarang mengembalikan `sha256`; `patch`
      menolak kalau hash tidak cocok (menghentikan silent overwrite antar-agent).
- [x] **`include_hidden` di `search_files`** — **tidak dikerjakan karena klaimnya salah.**
      Diuji langsung: `search_files` sudah menemukan `.secret/config.txt` di mode `files`
      maupun `content`. Jadi tidak ada filter dotfile yang perlu dibuka. Fitur
      `include_hidden` tetap ada di `list_dir` (untuk menyembunyikan, bukan membuka).

### P2 lanjutan — selesai
- [x] **`checkpoint`** (tool baru). `list` / `diff` / `undo` atas store yang sama dengan
      `/checkpoints`, `/diff`, `/undo` di REPL. Sebelumnya agent yang merusak file tidak bisa
      memulihkannya sendiri — harus user mengetik `/undo`.
- [x] **`schedule`** (tool baru). `list` / `add` / `remove` / `history` lewat `CronStore` yang
      sama dengan gateway Telegram. Cron divalidasi (`nextCronRun`), timezone default = host.
- [x] **`expected_hash` di `patch_batch`** (bukan tool `multi_edit` baru). Ternyata
      `patch_batch` **sudah** menangani banyak file secara atomik — jadi `multi_edit` akan
      duplikat. Yang kurang hanya proteksi konflik, dan itu sekarang ada: satu hash basi
      membatalkan seluruh batch tanpa menyentuh file lain (diuji).
- [x] **Pre-flight health di `tool_search`.** Setiap hasil sekarang punya
      `health: {status: ready|degraded|unavailable, detail}`. `browser_exec` diprobe nyata
      (`import playwright`, cache 5 menit), `web_search`/`web_extract` ditandai `degraded`
      (butuh HTTPS keluar), `image_generate` cek `api_key`, `vision_analyze` cek provider.
      Jadi tool yang backend-nya bolong kelihatan sebelum dipanggil, bukan setelah gagal.

### P2 penutup — selesai
- [x] **`tool_call` menolak lebih awal kalau backend `unavailable`.** Health dipindah ke modul
      netral `vallenagent/src/tools/tool_health.ts` supaya agent bisa memakainya tanpa import
      melingkar. `deferredToolGate()` memblokir hanya status `unavailable`; `degraded` tetap
      dijalankan karena tool itu mungkin masih berhasil.
- [x] Test: gate memblokir `unavailable`, meloloskan `degraded` dan `ready`; probe
      `browser_exec` diverifikasi sebagai probe nyata (bukan label statis).

### Sisa backlog
- (kosong)




---

## 5. Uji terakhir

Dijalankan `2026-11-09T15:35Z`, semua dari perintah nyata:

| Uji | Perintah | Hasil |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ bersih |
| Test suite (Node 20.19.2) | `npm test` | ✅ **266 + 72 pass, 0 fail** |
| Test suite (Node 24.22.1) | `npx node@24.22.1 ../scripts/run-tests.mjs tests` | ✅ **266 + 72 pass, 0 fail** |
| Tool terdaftar | `registry.list().length` | ✅ **32** (`list_dir`, `typecheck`, `checkpoint`, `schedule` baru) |
| Tool E2E via agent | `-p "Use the list_dir tool on /tmp/vpkg..."` | ✅ 5 entri, cocok dengan `ls \| wc -l` |
| Health E2E via agent | `-p "Call tool_search query 'browser'..."` | ✅ `ready · playwright importable via python3` (diverifikasi manual) |
| `--json` telemetry | `vallenemperor --json -p "/stats"` | ✅ satu objek JSON, exit 0 |
| `--quiet` | `printf '/exit\n' \| vallenemperor --quiet` | ✅ output kosong |
| `-p` slash: `/help` | `vallenemperor -p "/help"` | ✅ help CLI asli, exit 0 |
| `-p` slash: `/exit` | `vallenemperor -p "/exit"` | ✅ `Session ending.`, exit 0 |
| `-p` slash: unknown | `vallenemperor -p "/zzz-not-a-command-999"` | ✅ `Unknown command`, exit 2 |
| Approval blokir | `--approval dangerous -p "...git clean -n"` | ✅ diblokir, exit 1 |
| Approval izin | `--approval off -p "...git clean -n"` | ✅ dijalankan, exit 0 |
| Registry | `npm view vallenemperor version` | ✅ `999.999.999` |
| Install global | `npm install -g vallenemperor` (prefix bersih) | ✅ `vallenemperor v999.999.999`, `config show` exit 0 |
| Adapter terkirim | grep `platform.js` di tarball | ✅ 8 simbol (`resolveShell`/`killTree`/`spawnableCommand`) |
| Git | `git rev-list --count origin/main..HEAD` | lihat commit terakhir |

Belum terverifikasi (tidak ada akses hardware): Windows PowerShell/cmd, `taskkill`, `py -3`,
conhost fallback, build native Termux. Penjaganya: CI matrix + job `termux-shape`.

---

## 6. Perintah uji cepat

```bash
cd /home/vallenganteng/Destop/vallenemperor

npm run typecheck            # tipe
npm test                     # 247 + 57 test
node bin/vallenemperor --version
node bin/vallenemperor config show

# Node 24 (versi target user)
cd vallenagent && npx -y node@24.22.1 ../scripts/run-tests.mjs tests && cd ..
cd vallencli   && npx -y node@24.22.1 ../scripts/run-tests.mjs tests && cd ..

# rilis
./scripts/release.sh current      # publish versi sekarang
npm view vallenemperor version    # verifikasi registry
```
