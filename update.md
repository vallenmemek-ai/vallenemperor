# UPDATE.md — antrian perbaikan VallenEmperor

Dokumen kerja. Centang `[x]` **hanya setelah** perubahannya dibuktikan jalan (test pass + output nyata).
Jangan centang karena "sudah diedit".

Baseline sebelum dikerjakan (jalankan dulu, catat angkanya):

```
npm run build      → harus OK
npm run typecheck  → harus OK
npm test           → vallenagent 170/170, vallencli 47/47
```

Kalau angka awal beda, jangan lanjut — ada yang berubah di luar dokumen ini.

Aturan main:
- Satu item = satu commit mental. Jangan gabung 4 item dalam satu patch besar.
- Setiap item wajib punya test baru yang **gagal sebelum fix** dan lulus sesudahnya. Kalau test-nya lulus sebelum fix, test-nya tidak menguji apa pun — perbaiki test-nya, jangan hapus assertion.
- Jangan commit/push. Commit ditunda atas permintaan pemilik repo.

---

## [x] 1. Skill auto-load: kata berulang dihitung dua kali

**Bukti**
`vallenagent/src/skills/skills.ts:231`

```js
const words = messageLower.match(/[a-z0-9_+-]{3,}/g) || []
...
const filteredWords = words.slice(0, 128).filter(w => w.length <= 64 && !ignored.has(w))
```

`filteredWords` tidak di-dedupe, lalu dipakai di `skills.ts:251`:

```js
for (const w of filteredWords) {
  if (new RegExp(...).test(descLower)) wordMatches++
}
```

Ambang lolos di `skills.ts:261`:

```js
.filter(item => item.score >= 20 || (item.wordMatches >= 2 && item.score >= 4))
```

**Akibatnya**: prompt "coba di test test dulu" → `words = ['coba','test','test','dulu']`. Kata `test`
dihitung dua kali → `wordMatches = 2` → lolos ambang "minimal 2 kata". Skill test-driven-development
ke-load padahal cuma satu kata yang cocok, dan itu pun diulang user.

**Perbaikan**: dedupe sekali sebelum dipakai:

```js
const filteredWords = [...new Set(words.filter(w => w.length <= 64 && !ignored.has(w)))].slice(0, 128)
```

Perhatikan urutan: dedupe **sebelum** `slice`, supaya 128 kata pertama tetap 128 kata unik.

**Test wajib** (`vallenagent/tests/skills_relevance.test.mjs`, baru):
- `getRelevantSkills('coba di test test dulu')` tidak memuat skill yang deskripsinya cuma cocok 1 kata.
- `getRelevantSkills('test driven development red green refactor')` tetap memuat skill TDD (jangan sampai fix ini mematikan match yang benar).
- Dua kata berbeda yang sama-sama cocok tetap lolos ambang (mis. "github pull request").

**Bukti selesai**: test di atas gagal di kode lama (jalankan sekali dengan fix dilepas), lulus setelah fix, dan `npm test` tetap hijau.

Selesai: 2026-11-09
File: vallenagent/src/skills/skills.ts:229-233 (dedupe sebelum slice)
Test: vallenagent/tests/skills_relevance.test.mjs (3 test: kata berulang, match sah, dua kata berbeda) — gagal sebelum fix: ya (test 1), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: dedupe pakai `new Set(...)` sebelum `slice(0,128)`, jadi 128 kata pertama tetap unik.

---

## [x] 2. Checklist hantu bikin "Task incomplete" palsu

**Bukti**
`vallenagent/src/agent/agent.ts:425-429` — todo otomatis dibuat untuk apa pun yang dianggap task:

```js
const hasOpenTask = this.todoStore.read().some(todo => todo.status === 'pending' || todo.status === 'in_progress')
if (!this.isSubagent && !hasOpenTask && !/^\/plan(?:\s|$)/.test(trimmedUserMsg) && isTaskExecutionRequest(trimmedUserMsg)) {
  this.todoStore.write([{ id: `request-${Date.now()}`, content: goal, status: 'in_progress' }], true)
}
```

Pemicunya Teks nudge yang dikeluhkan model ("previous response attempted to finish early, continue") berasal dari
`agent/agent.ts:735`:

```js
safeCallback(callbacks?.onThinking, `Checklist still has ${pendingTasks.length} open task(s); continuing.`)
```

Pemicunya `vallenagent/src/agent/agent_task_intent.ts:4` (regex di baris 7) — daftar kata `update|buat|gas|lanjut|continue|...`.
Pertanyaan seperti "ini pertanyaan jujur kah bang ... biar enak gw **update**" ikut dianggap task.

Jalan keluar satu-satunya di `agent/agent.ts:724`:

```js
const onlyAutoGoals = pendingTasks.every(task => task.id.startsWith('request-'))
if (onlyAutoGoals && toolCallCount > 0 && prematureFinalAttempts >= 2 && (assistantMessage.content || '').trim()) {
  this.todoStore.write(pendingTasks.map(task => ({ id: task.id, status: 'completed' as const })), true)
  acceptedAutoGoal = true
} else if (prematureFinalAttempts > maxPrematureFinalAttempts) {
  return { response: `...Task incomplete; checklist still open after 2 continuation attempts...`, completionStatus: 'incomplete' }
}
```

**Reproduksi**: terjadi di dua model berbeda (claude-class dan deepseek-class) untuk pertanyaan meta
("ini pertanyaan jujur kah bang..."), dua-duanya berakhir dengan footer yang sama, id
`request-1794163801765` / `request-1794164830473` masih `in_progress`. Jadi ini bukan kebiasaan satu model.

**Akibatnya**: untuk pertanyaan murni (jawaban tanpa tool call, atau ada todo lain non-`request-`),
syarat `toolCallCount > 0` tidak pernah kena → dua kali di-nudge → turn ditutup dengan footer
"Task incomplete; checklist still open after 2 continuation attempts" padahal jawabannya sudah lengkap.
Ini yang bikin CLI kelihatan rusak padahal cuma ditanya.

**Perbaikan** (dua bagian, keduanya perlu):
1. `agent.ts:724` — terima jawaban kalau model sudah menjawab dan **tidak ada tool call yang tertunda**:
   ganti syarat `toolCallCount > 0` jadi "jawaban non-kosong dan tidak ada tool call di iterasi terakhir",
   sehingga pertanyaan tanpa eksekusi tetap dianggap selesai. Auto-goal `request-*` ditandai `completed`.
2. `agent_task_intent.ts:7` — jangan anggap task kalau kalimatnya interogatif: tambahkan deteksi
   pertanyaan bahasa Indonesia (`kah` di akhir klausa, `apa`, `kenapa`, `gimana`, `saran`, `menurut lu`,
   `pendapat`), bukan cuma kata kerja di tengah kalimat.

**Test wajib** (`vallenagent/tests/turn_loop.behaviour.test.mjs`, tambah):
- Pertanyaan berisi kata "update" tanpa tool call → `completionStatus === 'complete'`, tidak ada
  `request-` yang tersisa `in_progress`, dan response tidak memuat "Task incomplete".
- Permintaan nyata ("benerin bug X") yang model jawab tanpa tool call → tetap kena nudge (jangan
  melonggarkan sampai task asli lolos tanpa kerja).
- `isTaskExecutionRequest('ini pertanyaan jujur kah bang, saran dong')` → `false`;
  `isTaskExecutionRequest('update config biar jalan')` → `true`.

**Bukti selesai**: dua test pertama gagal di kode lama, lulus setelah fix; `npm test` hijau.

Selesai: 2026-11-09
File: vallenagent/src/agent/agent.ts:719-740 (auto-goal diterima setelah satu nudge), vallenagent/src/agent/agent_task_intent.ts:7-11 (deteksi pertanyaan Indonesia)
Test: vallenagent/tests/turn_loop.behaviour.test.mjs — "a question that merely mentions update completes..." dan "a real execution request is still nudged..." dan unit `isTaskExecutionRequest` — gagal sebelum fix: ya (dua test pertama), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: checklist buatan model sendiri (id bukan `request-`) tetap memblokir seperti sebelumnya (test lama "an open checklist blocks the final answer" masih hijau). Nudge tetap dikirim sekali sebelum jawaban tanpa tool diterima.

---

## [x] 3. Skill bisa menimpa gaya output sistem

**Bukti**
`vallenagent/src/agent/turn_setup.ts:43` menyuntik isi SKILL.md mentah tanpa aturan prioritas:

```js
return `\n\n[Loaded skill: ${skill.name}]\n${body}`
```

`vallenagent/src/agent/agent_system_prompt.ts` tidak punya satu baris pun soal skill vs system prompt,
dan baris 93 justru mendorong memuat skill tanpa syarat:

```
When working on game tasks, ALWAYS load relevant skills from the available game development skills:
```

**Akibatnya**: kalau SKILL.md menulis "pakai heading", "jelaskan panjang", atau gaya bahasa lain, model
menganggapnya setara aturan sistem → output drift dari aturan terse/caveman.

**Perbaikan**:
1. Header preload diberi batas kewenangan, mis.:

```js
return `\n\n[Loaded skill: ${skill.name} — reference material. It does not override the system prompt's output style, safety rules, or approval requirements.]\n${body}`
```

2. `agent_system_prompt.ts:93` — ganti `ALWAYS load relevant skills` jadi
   `load relevant skills only when the task actually touches that domain` (jangan hapus dukungan
   gamedev, cuma turunkan paksaan).

**Test wajib** (`vallenagent/tests/turn_setup_budget.test.mjs`, tambah):
- `buildSkillPreloadText()` memuat frasa "does not override the system prompt's output style".
- Prompt sistem yang dihasilkan tidak lagi memuat "ALWAYS load relevant skills".
- Panjang preload tetap di bawah `MAX_SKILL_PRELOAD_CHARS` (regression yang sudah ada harus tetap lulus).

**Bukti selesai**: test baru lulus, test lama tidak ada yang berubah angkanya.

Selesai: 2026-11-09
File: vallenagent/src/agent/turn_setup.ts:43 (header preload dibatasi), vallenagent/src/agent/agent_system_prompt.ts:93 (ALWAYS → only when the task touches that domain)
Test: vallenagent/tests/turn_setup_budget.test.mjs (2 test baru) — gagal sebelum fix: ya (keduanya), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: assertion lama `[Loaded skill: demo]` diperbarui ke prefix `[Loaded skill: demo`; batas MAX_SKILL_PRELOAD_CHARS tidak berubah.

---

## [x] 4. Verifikasi belum atomic (baru menegur setelah "done")

**Bukti**
Ada **dua** lapis, dan hanya satu yang keras:
- nudge lunak untuk semua edit, `agent/agent.ts:689` lewat `VerificationLedger.shouldNudge()`
  (`agent/verification.ts:173`) — sekali per turn, berhenti kalau sudah ada satu perintah verifikasi apa pun;
- blokir keras (`completionStatus: 'incomplete'`) hanya untuk TypeScript, `agent/agent.ts:702`.

`vallenagent/src/agent/agent.ts:702`:

```js
if (!toolCalls?.length && toolCallCount > 0 && this.verificationTypescriptChanged && !this.verificationTypescriptVerified) {
  return { response: `${...}\n\nTask incomplete: TypeScript changes lack a successful typecheck in this turn.`, ... }
}
```

Jadi model menulis "selesai" dulu, baru ditegur. Selain itu penjaga ini **hanya** untuk TypeScript —
test suite, build, dan lint tidak dijaga sama sekali.

Alat yang sudah tersedia dan belum dipakai untuk ini: `vallenagent/src/agent/verification.ts:32`
`isVerificationCommand(command)` (sudah membedakan perintah verifikasi vs read-only).

Tambahan: pemicu typecheck berbasis **ekstensi file**, bukan keberadaan `tsconfig.json` —
`agent/agent.ts:1067-1068` menandai `verificationTypescriptChanged` dari `evidence.typescriptEdited`
(lihat `agent/tool_evidence.ts`). Jadi repo TS tanpa tsconfig tetap dipaksa typecheck, dan sebaliknya
tidak ada penyesuaian per proyek.

**Perbaikan**: perluas pelacakan yang sudah ada (`verificationTypescriptChanged` /
`verificationTypescriptVerified`) jadi tiga kelompok: typecheck, test, build. Saat sebuah edit terjadi,
tandai kelompok yang relevan sebagai "kotor". Sebelum menerima final answer, kalau ada kelompok kotor
yang belum terverifikasi, tolak sekali dan minta perintah verifikasinya (bukan mengarang hasil).

**Test wajib** (`vallenagent/tests/turn_loop.behaviour.test.mjs`, tambah):
- Edit file `.ts` lalu final answer tanpa `tsc` → `completionStatus === 'incomplete'` (perilaku lama,
  harus tetap).
- Edit file uji (`*.test.mjs`) lalu final answer tanpa menjalankan test → `incomplete`.
- Edit apa pun lalu jalankan verifikasi yang cocok, baru final answer → `complete`.
- Perintah read-only (`ls`, `git status`) **tidak** dihitung sebagai verifikasi.

**Catatan**: ini item paling besar. Kerjakan terakhir, setelah 1-3 stabil.
Selesai: 2026-11-09
File: vallenagent/src/agent/verification.ts:41-68 (`VerificationGroup`, `verificationGroupsForCommand`, `shouldNudge(dirty, verified)`), vallenagent/src/agent/tool_evidence.ts:5-25,57-80 (klasifikasi test/build config), vallenagent/src/agent/agent.ts:96-101,390-394,689-712,1085-1110 (tiga kelompok bukti + blokir sebelum final answer)
Test: vallenagent/tests/turn_loop.behaviour.test.mjs (4 test) — gagal sebelum fix: ya (2 dari 4: edit file uji dan perintah read-only), lulus sesudah: ya; 2 lainnya adalah regression guard (TS edit tetap incomplete, edit + verifikasi cocok tetap complete)
npm test: vallenagent 207/207, vallencli 50/50
Catatan: kelompok `build` dipicu edit config build (package.json/tsconfig/*.config.*/Makefile/Dockerfile); command verifikasi generik (eslint dll) dihitung sebagai bukti tingkat build. Pemicu typecheck masih berbasis ekstensi file (belum membaca tsconfig.json) — itu catatan terpisah di item ini, tidak diubah.

---

## [x] 5. (Opsional) Preview diff belum muncul pada edit biasa

**Bukan bug** — kemampuannya ada, cuma tidak terpicu.

- `vallencli/src/cli.mjs:38` → `const editPreviewFor = request => (isEditTool(request?.name) ? buildEditPreview(request.args) : null)`
- `vallencli/src/cli.mjs:455` → `const preview = editPreviewFor(request)` lalu diteruskan ke `formatApprovalBox({ ..., preview })` di baris 457
- `vallencli/src/cli-ui.mjs:373` `buildEditPreview`, `cli-ui.mjs:394` `formatApprovalBox`

Default mode approval `vallenagent/src/core/approval.ts:27` adalah `'dangerous'`, jadi edit file biasa
tidak memunculkan prompt → preview tidak pernah tampil. Untuk melihatnya sekarang:
`approval: "all"` di `~/.vallenemperor/config.json` atau `VALLENEMPEROR_APPROVAL=all`.

Kalau mau dinaikkan jadi fitur: tampilkan preview diff juga untuk edit besar (mis. > 20 baris berubah)
walau mode `dangerous`. Perlu keputusan pemilik repo dulu — jangan dikerjakan tanpa izin.

Selesai: 2026-11-09
File: vallencli/src/cli.mjs:38-53 (`BIG_EDIT_PREVIEW_LINES = 20`, `bigEditPreview`), 442-470 (`askApproval` menampilkan preview diff untuk edit besar walau mode `dangerous`, dan tidak memakai grant "always" untuk edit besar), 486-500 (baris `size` di kotak approval)
Test: vallencli/tests/cli.test.mjs (3 test: ambang baris, non-edit/non-interaktif diabaikan, run non-interaktif tidak menggantung menunggu input) — gagal sebelum fix: ya (API belum ada), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 56/56
Catatan: keputusan pemilik repo diambil = tampilkan preview + minta approval untuk edit > 20 baris berubah. Hanya di permukaan interaktif; run `-p` tidak pernah menunggu input. Mode `off` tetap menghormati `off` karena tidak ada yang bisa ditanya di non-TTY, tapi di TTY edit besar tetap ditanya — kalau mau `off` benar-benar bebas, itu perubahan terpisah.

---

## [x] 6. Skill aktif tidak pernah dilepas saat topik ganti

**Bukti**
`vallenagent/src/agent/turn_setup.ts:34` — kalau tidak ada skill yang cocok, skill lama tetap dipakai:

```js
return matched[0] || activeSkill || null
```

`vallenagent/src/agent/agent.ts:433` — hanya menimpa, tidak pernah mengosongkan:

```js
if (matchedSkill) this.activeSkill = matchedSkill
```

Reset cuma di `agent.ts:285` (load session) dan `agent.ts:309` (`/new` / reset).

**Akibatnya**: skill yang ke-load sekali (mis. himalaya karena ada kata "email") disuntik terus di
setiap turn berikutnya walau topiknya sudah pindah. Ini penyebab "skill auto-load kelihatan agresif"
yang dilaporkan dua model — bukan cuma soal skor (item 1), tapi karena tidak ada pelepasan.

**Perbaikan**: bedakan skill yang dimuat **eksplisit** (user memanggil `/skill`, atau model memanggil
`skill_view`) dari yang dimuat otomatis. Yang otomatis hanya berlaku untuk turn itu; kalau pesan
berikutnya tidak cocok, jangan disuntik lagi. Yang eksplisit tetap lengket sampai `/new`.

**Test wajib** (`vallenagent/tests/skills_relevance.test.mjs`):
- Pesan A memuat skill email → `selectSkillToPreload` mengembalikan skill itu.
- Pesan B "apa kabar" (tidak cocok apa pun) → `null`, bukan skill lama.
- Skill yang dimuat eksplisit tetap dipertahankan pada pesan berikutnya.

Selesai: 2026-11-09
File: vallenagent/src/agent/agent.ts:71-72 (semantik activeSkill = eksplisit), 432-436 (auto-match tidak lagi disimpan), 1100-1112 (skill_view menandai skill eksplisit)
Test: vallenagent/tests/turn_loop.behaviour.test.mjs — "an auto-loaded skill is released once the topic changes" (gagal sebelum fix: ya) dan "a skill loaded explicitly with skill_view stays active" (regression guard, lulus sebelum & sesudah)
npm test: vallenagent 207/207, vallencli 50/50
Catatan: `selectSkillToPreload(loader, message, activeSkill)` tidak berubah tanda tangan; `activeSkill` sekarang hanya berisi skill eksplisit, jadi fallback-nya berarti "eksplisit tetap lengket sampai /new".

---

## [x] 7. Prompt melarang markdown, tapi CLI sendiri merender markdown

**Bukti**
`vallenagent/src/agent/agent_system_prompt.ts:24`:

```
Balasan tampil di terminal yang mencetak karakter mentah, jadi jangan pakai formatting markdown:
tanpa bold, tanpa backtick, tanpa heading, tanpa tabel pipe.
```

Padahal output asisten dirender sebagai markdown di `vallencli/src/cli.mjs:580`:

```js
if (!streamed) printResponse(result.response, { markdown: true, footer })
```

dan `vallencli/src/cli-markdown.mjs` memang punya renderer code fence, bold, heading, tabel.

**Akibatnya**: instruksi dan UI saling bertentangan. Model disuruh menulis teks polos padahal
renderer-nya siap menampilkan markdown. Sementara SKILL.md yang disuntik itu markdown penuh (fence,
tabel), jadi model harus menulis ulang formatnya manual — persis keluhan "reflow manual".

**Perbaikan** — pilih satu, jangan dua-duanya:
- **(disarankan)** izinkan markdown untuk balasan asisten (renderer sudah ada), dan sisakan aturan teks
  polos untuk echo perintah terminal / output tool;
- atau pertahankan teks polos, tapi buang fence/tabel saat menyuntik SKILL.md supaya model tidak perlu
  menerjemahkan format.

**Test wajib**: prompt sistem tidak lagi memuat larangan backtick untuk balasan asisten; test renderer
markdown yang sudah ada (`vallencli/tests/ui.test.mjs`) tetap lulus.

Selesai: 2026-11-09
File: vallenagent/src/agent/agent_system_prompt.ts:23-26 (aturan output: markdown untuk balasan asisten, teks polos untuk command/isi file)
Test: vallenagent/tests/turn_setup_budget.test.mjs — "the system prompt allows markdown in assistant replies but keeps tool/command text plain" — gagal sebelum fix: ya, lulus sesudah: ya; vallencli/tests/ui.test.mjs tetap hijau
npm test: vallenagent 207/207, vallencli 50/50
Catatan: opsi yang dipilih adalah yang disarankan (izinkan markdown), renderer `cli-markdown.mjs` tidak diubah.

---

## [x] 8. `patch`/`write_file` wajib baca seluruh file walau cuma mengubah 1 baris

**Bukti**
`vallenagent/src/tools/builtin_tools/file_tools.ts:70-76`:

```js
// dipakai di :384 — patch menolak partial: "Refusing to patch: read the complete current file with read_file first."
function fileReadStatus(context, path, text): 'unread' | 'stale' | 'partial' | 'ready' {
  if (!coverage) return 'unread'
  if (coverage.hash !== hashText(text) || coverage.totalLines !== text.split('\n').length) return 'stale'
  return coverage.ranges.some(([start, end]) => start <= 1 && end >= coverage.totalLines) ? 'ready' : 'partial'
}
```

`'ready'` hanya kalau satu range menutup baris 1 sampai baris terakhir. Baca sebagian = `'partial'`,
dan `patch` menolak `'partial'`.

Guard yang sama dipakai untuk overwrite, `vallenagent/src/tools/builtin_tools/file_tools.ts:298`:

```js
if (readStatus === 'partial') return JSON.stringify({ error: 'Refusing to overwrite: read the complete current file with read_file first.' })
```

**Akibatnya**: mengubah satu baris di file 2.000 baris memaksa menarik 2.000 baris ke konteks dulu.
Berlaku untuk `patch` (:384) **dan** `write_file` saat menimpa file lama (:298).

**Perbaikan**: terima `'partial'` kalau (a) hash masih cocok (tidak stale) **dan** (b) `old_string` yang
akan diganti muncul tepat satu kali di file. Dua syarat itu yang sebenarnya melindungi: isi file tidak
berubah sejak dibaca, dan target edit tidak ambigu. Penolakan `'unread'` dan `'stale'` tetap.

**Test wajib** (`vallenagent/tests/patch_engine.test.mjs`, tambah):
- Baca sebagian (offset/limit) + `old_string` unik → patch berhasil.
- Baca sebagian + `old_string` muncul dua kali → tetap ditolak (ambigu).
- File berubah di disk setelah dibaca → tetap ditolak (`stale`).
- File belum pernah dibaca → tetap ditolak (`unread`).

Selesai: 2026-11-09
File: vallenagent/src/tools/builtin_tools/file_tools.ts:294-300 (overwrite boleh partial selama hash cocok), 380-396 (patch boleh partial kalau old_string unik / replace_all)
Test: vallenagent/tests/patch_engine.test.mjs (4 test baru, memakai registry tool nyata: read_file → patch) — gagal sebelum fix: ya (2 dari 4), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: `unread` dan `stale` tetap ditolak; pesan error partial sekarang menyebut syarat old_string unik.

---

## [x] 9. Deferred tool butuh tiga hop untuk satu aksi

**Bukti** — `vallenagent/src/tools/builtin_tools/integration_tools.ts`:
- `:109` `tool_search` — "Find deferred tools by name or capability. Call tool_describe before tool_call."
- `:129` `tool_describe` — "Return full schema for one deferred tool."
- `:138` `tool_call` — "Execute a deferred tool after tool_search and tool_describe."

**Akibatnya**: satu aksi deferred = 3 round trip. Untuk tool yang cuma dipakai sekali, biayanya lebih
besar daripada manfaat schema yang dihemat.

**Perbaikan**: `tool_search` langsung mengembalikan `parameters` (schema penuh) bersama name/description,
sehingga jalur normal jadi 2 hop (`search` → `call`). `tool_describe` tetap ada untuk kompatibilitas.
Efek ke ukuran prompt sistem: nol — schema masuk ke hasil tool, bukan ke prompt.

**Test wajib**: hasil `tool_search` memuat field `parameters`; `tool_call` berhasil tanpa didahului
`tool_describe`.

Selesai: 2026-11-09
File: vallenagent/src/tools/builtin_tools/integration_tools.ts:109-126 (tool_search mengembalikan `parameters`), deskripsi tool_describe/tool_call disesuaikan
Test: vallenagent/tests/deferred_tools.test.mjs — test 1 (parameters ada) gagal sebelum fix: ya; test 2 (tool_call tanpa tool_describe) lulus sebelum & sesudah (regression guard)
npm test: vallenagent 207/207, vallencli 50/50
Catatan: ukuran prompt sistem tidak berubah — schema hanya ada di hasil tool. `tool_describe` tetap tersedia.

---

## [x] 10. Proses background jadi yatim setelah `/new`

**Bukti**
`vallenagent/src/core/process_manager.ts:26` — proses dicatat dengan pemilik = id sesi:

```js
export function startBackgroundProcess(command, cwd, owner, onExit?) { ... }
```

`process_manager.ts:89` — daftar proses difilter ketat per pemilik:

```js
if (action === 'list') return { processes: [...processes.values()].filter(entry => entry.owner === owner).map(snapshot) }
```

`process_manager.ts:76` — akses proses milik sesi lain ditolak:

```js
return entry?.owner === owner ? entry : 'Unknown process session_id'
```

Sesi baru (`/new`) punya id baru, dan `vallenagent/src/tools/builtin_tools/terminal_tools.ts:64,206`
selalu memakai `context.sessionId || 'default'` sebagai owner.

**Akibatnya**: server/proses yang dijalankan di sesi lama tetap hidup tapi **tidak bisa dipoll, dibaca
outputnya, atau dihentikan** dari sesi baru — `process_manage list` tidak menampilkannya. Hasilnya proses
yatim: port tetap terpakai, tidak ada cara menghentikannya lewat tool.

**Perbaikan** (pilih salah satu, jangan dua-duanya):
- **(disarankan)** `process_manage list` mengembalikan semua proses yang hidup beserta `owner`-nya, dan
  `kill` boleh lintas sesi setelah konfirmasi; ATAU
- saat sesi ditutup/diganti, hentikan proses milik sesi itu (dengan catatan di output bahwa proses
  dihentikan), supaya tidak ada yatim.

**Test wajib** (`vallenagent/tests/process_manager.test.mjs`, baru):
- Sesi A menjalankan proses background; sesi B memanggil `list` → proses A terlihat (atau sudah
  dihentikan bila memilih opsi kedua), bukan hilang tanpa jejak.
- `kill` dari sesi B terhadap proses sesi A: sesuai keputusan di atas (diizinkan dengan konfirmasi, atau
  ditolak dengan pesan jelas).
- Proses milik sesi sendiri tetap bisa `poll`/`wait`/`kill` seperti sekarang (jangan merusak yang ada).

Selesai: 2026-11-09
File: vallenagent/src/core/process_manager.ts:76-115 (list lintas sesi + owner/owned, kill lintas sesi butuh `confirm: true`), vallenagent/src/tools/builtin_tools/terminal_tools.ts:188-203 (schema `confirm`)
Test: vallenagent/tests/process_manager.test.mjs (4 test) — gagal sebelum fix: ya (3 dari 4), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: opsi yang dipilih adalah opsi pertama (list lintas sesi + kill dengan konfirmasi); poll/wait lintas sesi diizinkan karena read-only.

---

## [x] 11. CLI tidak punya permukaan flag/subcommand

**Bukti**
`vallencli/src/cli.mjs:690-696` — seluruh parsing argumen cuma ini:

```js
function parseArgs(argv) {
  const args = new Set(argv)
  if (args.has('--help') || args.has('-h')) return 'help'
  if (args.has('--version') || args.has('-v') || args.has('-versi')) return 'version'
  return 'run'
}
```

**Akibatnya**: tidak ada `--resume`, `--continue`, `--prompt "..."` (one-shot), `--approval`, `--model`,
maupun subcommand `run`/`spawn`. Semua argumen lain jatuh ke `'run'` = REPL interaktif, jadi argumen
yang tidak dikenal **diabaikan diam-diam** (tidak error, tidak dipakai). Ini sumber "gue muter-muter
nebak flag": flag-nya memang belum ada, dan salah pakai tidak memunculkan peringatan.

Catatan: `/resume` dan `/sessions` ada sebagai **slash command** di dalam REPL
(`vallencli/src/cli-commands.mjs:58,63`), bukan sebagai flag startup.

**Perbaikan**: tambahkan parser argumen yang eksplisit dan tolak yang tidak dikenal:
- `vallenemperor` → REPL (perilaku sekarang)
- `vallenemperor -p "prompt"` → one-shot, cetak hasil, keluar
- `vallenemperor --resume [id]` → lanjutkan sesi terakhir / id tertentu
- `--approval dangerous|all|off`, `--model <nama>` → override config untuk sesi itu
- `--help` mencantumkan semuanya; argumen tak dikenal → exit 2 dengan pesan.

**Test wajib** (`vallencli/tests/cli.test.mjs`, tambah):
- `parseArgs(['--resume'])` → `'resume'`; `parseArgs(['-p','halo'])` → `'prompt'` + payload.
- Argumen tak dikenal → error jelas (bukan diam-diam jadi `'run'`).
- `--help` memuat semua flag di atas.

Selesai: 2026-11-09
File: vallencli/src/cli.mjs:690-760 (parseArgs eksplisit + runOneShot + override approval/model + resume), vallencli/src/cli.mjs:53-64 (resume saat start), vallencli/src/cli-ui.mjs:63 (HELP memuat startup flags)
Test: vallencli/tests/cli.test.mjs (3 test baru: flag terdokumentasi, argumen tak dikenal → error, help memuat semua flag) — gagal sebelum fix: ya (parseArgs belum diekspor), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: `parseArgs` mengembalikan objek `{ mode, prompt, resumeId, approval, model, error }`; argumen tak dikenal → mode `error` dan `main()` exit 2. `--resume` tanpa id memakai sesi terbaru dari `listSessions()`.

---

## [x] 12. Katalog skill eksternal menunjuk repo yang tidak ada (404)

**Bukti**
`vallenagent/src/skills_hub/search.ts:59` — URL katalog eksternal di-hardcode:

```js
const rawUrl = `https://raw.githubusercontent.com/vallenmulia99/vallenemperor/main/.vallenemperor/skills/${category.name}/${entry.name}/SKILL.md`
```

Diverifikasi: `curl https://api.github.com/repos/vallenmulia99/vallenemperor` → **404**. Repo itu tidak ada.

**Akibatnya**: jalur katalog eksternal selalu gagal. Karena kegagalannya ditelan (`catch` → `[]`), user
tidak melihat error apa pun — skill eksternal seolah "kosong", bukan "rusak". Katalog lokal
(`VALLENEMPEROR_BUNDLED_SKILLS` / `.vallenemperor/skills`) tetap jalan, jadi fiturnya tidak mati total,
tapi separuh jalur mati dan menyembunyikan penyebabnya.

**Perbaikan**:
1. Buat sumber katalog bisa dikonfigurasi: `VALLENEMPEROR_SKILLS_CATALOG` (owner/repo) di config, dengan
   default ke repo milik user setelah repo barunya ada.
2. Kalau fetch gagal, kembalikan penanda yang terlihat (mis. `{ error: 'catalog unreachable' }` yang
   dicetak `/skills search`), jangan `[]` kosong yang tidak bisa dibedakan dari "tidak ada hasil".

**Test wajib** (`vallenagent/tests/skills_hub_search.test.mjs`, tambah):
- URL katalog mengikuti env/config, bukan string hardcode.
- Fetch gagal → hasil memuat status error yang bisa ditampilkan, bukan array kosong tanpa keterangan.

Selesai: 2026-11-09
File: vallenagent/src/skills_hub/search.ts:16-56 (repo katalog dari `VALLENEMPEROR_SKILLS_CATALOG`, `officialCatalogUrls`, `getCatalogError`), 60-105 (`loadOfficialCatalogFromGitHub` mencatat kegagalan), vallencli/src/cli-commands.mjs:189-195 (`/skills search` mencetak status katalog)
Test: vallenagent/tests/skills_hub_search.test.mjs (3 test baru: URL ikut env, kegagalan tercatat, sukses menghapus error) — gagal sebelum fix: ya (API belum ada), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: default repo masih `vallenmulia99/vallenemperor`; ganti dengan env setelah repo baru ada. Katalog lokal tetap dipakai lebih dulu bila ditemukan.

---

## [x] 13. (Fitur) Onboarding provider: preset + validasi nama

**Bukan bug** — penamaan yang disebut model (`providers.custom.X.apiKey`, default "openrouter") tidak ada
di kode sekarang. Yang benar, `vallenagent/src/core/config.ts:48-56`:

```js
providers: {
  active: '9router',
  '9router': { base_url: 'http://127.0.0.1:20128/v1', api_key: '', model: 'ag/gemini-3.8-flash-medium', enabled: true }
}
```

Jadi bentuknya `providers.<nama-bebas>` dengan `base_url` / `api_key` / `model` / `enabled`, dan
`providers.active` menunjuk salah satunya. Yang **belum** ada: preset untuk provider populer, dan validasi
saat `active` menunjuk provider yang tidak ada / `base_url` kosong.

**Usulan** (kalau mau sekelas Hermes/opencode):
- preset `openrouter`, `openai`, `anthropic`, `deepseek`, `9router`, `ollama` — sekali `config set` langsung
  terisi `base_url` + nama variabel env untuk key, bukan menebak URL.
- validasi: `active` harus ada di `providers`; `base_url` wajib valid; `api_key` kosong → pesan jelas
  "set ENV X atau jalankan config set".
- key tetap dari `.env`/env, jangan ditulis ke config.json.

**Test wajib**: preset menghasilkan konfigurasi valid; `active` menunjuk provider tidak ada → error jelas;
`base_url` kosong → error jelas.

Selesai: 2026-11-09
File: vallenagent/src/core/config.ts:79-152 (`PROVIDER_PRESETS`, `providerPresetConfig`, `validateProviderConfig`), 300-320 (`getActiveProvider` memvalidasi base_url + mengingatkan env key)
Test: vallenagent/tests/config_providers.test.mjs (5 test) — fitur baru, gagal sebelum fix: ya (API belum ada), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: preset: openrouter, openai, anthropic, deepseek, 9router, ollama. Key hanya dibaca dari env (tidak pernah ditulis ke config.json). Permukaan `config set` menyusul di batch berikutnya (lihat bagian "Update berikutnya").

---

## [x] 14. (Fitur) Jalur bukti/artefak hasil kerja

**Sebagian valid.** Artefak **sudah** disimpan ke disk dan path-nya dikembalikan: gambar dari
`media_tools.ts:81` (`writeFileSync(finalPath, buf)` → path), dan output tool yang kepanjangan dipotong
dengan file penuh tersimpan (`tools/builtin_tools/tool_output.ts`). Yang belum ada: satu tempat untuk
"hasil kerja turn ini" yang bisa dirujuk ulang (daftar file yang diubah/dibuat + link) di akhir turn.

**Usulan**: di akhir turn, cetak ringkasan artefak: file yang diubah (dari diff patch), file baru yang
ditulis, gambar/output yang disimpan, plus perintah verifikasi yang dijalankan. Ini juga menutup keluhan
"diff stat tidak ada di laporan akhir".

**Test wajib**: turn yang mengubah 2 file + menulis 1 file baru → ringkasan memuat 3 path; turn tanpa
perubahan → ringkasan kosong/tidak dicetak.

Selesai: 2026-11-09
File: vallenagent/src/agent/turn_artifacts.ts (baru: created/changed/saved/verification + `buildArtifactSummary`), vallenagent/src/agent/agent.ts:97-99,1090-1112,825-838 (artifacts di hasil turn), vallenagent/src/agent/agent_types.ts:19-41, vallenagent/src/tools/builtin_tools/file_tools.ts:283,327 (`created` di hasil write_file), vallencli/src/cli.mjs:590-591,782 (cetak ringkasan)
Test: vallenagent/tests/turn_artifacts.test.mjs (4 test: 2 ubah + 1 baru → 3 path, tanpa perubahan → kosong, edit gagal/read-only diabaikan, runTurn membawa summary) — fitur baru, gagal sebelum fix: ya, lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 50/50
Catatan: ringkasan hanya muncul kalau ada isinya; verifikasi yang dicatat hanya command verifikasi sukses (read-only tidak dihitung).

---

## Yang sudah diperiksa dan **bukan** bug (jangan "diperbaiki")

- **Tracking file sudah dibaca**: `vallenagent/src/tools/builtin_tools/file_tools.ts:70`
  `fileReadStatus(context, path, text)` mengembalikan `'unread' | 'stale' | 'partial' | 'ready'`
  pakai hash + jumlah baris; `patch`/`write_file` menolak file yang belum dibaca atau berubah.
- **Preview edit sudah ada**: lihat item 5.
- **Nama tool MCP mentah di manager**: `McpManager.getTools()` memang mengembalikan nama asli
  (`echo`); prefix `mcp__<server>__<tool>` dibuat di `agent/mcp_wiring.ts` lewat
  `createMcpToolRegistration`. Dua lapisan ini disengaja dan sudah ada test-nya
  (`vallenagent/tests/mcp_e2e.test.mjs`).
- **`installFromQuarantine` / `uninstallSkill` tidak pernah throw**: keduanya menangkap error dan
  mengembalikan `{ success: false, error }`. Test yang memakai `assert.throws` untuk fungsi ini salah.
- **Aturan "caveman English"** yang dikeluhkan salah satu model: tidak ada di prompt VallenEmperor.
  `grep -in "caveman|terse|fragment" vallenagent/src/agent/agent_system_prompt.ts` hanya menemukan
  "fragment shader" di seksi gamedev. Yang ada: aturan ringkas berbahasa Inggris (baris 36) + seksi
  "Indonesian Casual Language Understanding" (baris 52). Kalau output terasa campur bahasa, itu bukan
  dari aturan caveman — jangan "perbaiki" aturan yang tidak ada.
- **Fuzzy patch "gagal karena indent/whitespace"**: `vallenagent/src/core/patch_engine.ts` punya 8
  strategi berurutan — exact (:67), line trimmed (:79), whitespace normalized (:100), indentation
  flexible (:120), escape normalized (:144), trimmed boundary (:157), unicode normalized (:186), block
  anchor (:222). Indent dan whitespace sudah punya strategi sendiri. Yang benar: kalau semua gagal,
  model harus menyusun payload baru (aturan "never retry the same payload" di prompt) — itu perilaku
  yang diinginkan, bukan kelemahan matching.
- **"Tidak ada state persisten antar sesi"**: sesi disimpan dan bisa dilanjutkan —
  `vallenagent/src/session/session.ts:164` `listSessions()`, perintah `/sessions` dan `/resume` di
  `vallencli/src/cli-commands.mjs:58,63`, plus checkpoint per turn (`agent/turn_recovery.ts`) dan
  `MEMORY.md`. Yang tidak otomatis cuma "konteks kerja turn terakhir" — itu memang tugas `/resume`,
  bukan fitur yang hilang.
- **Key config `spwn_tmout`**: tidak ada. `grep -rn "spwn_tmout"` di `vallenagent/src` dan
  `vallencli/src` → kosong. Nama config yang ada ditulis penuh (`max_iterations`, `max_tokens_per_turn`,
  `mcpServers`, `providers.active`). Jangan menambah alias untuk masalah yang tidak ada.
- **`providers.custom.X.apiKey` / default "openrouter"**: tidak ada di kode. Bentuk sebenarnya
  `providers.<nama-bebas>` + `providers.active` (lihat item 13).
- **`read_file` tidak mengembalikan isi lengkap / tanpa nomor baris**: salah, `read_file` mengembalikan
  `LINE_NUM|CONTENT` (`tools/builtin_tools/file_tools.ts:119-140`) dan `patch` menolak file yang belum
  dibaca / basi (`file_tools.ts:384`). Dua model berbeda mengklaim fitur ini tidak ada, padahal ada.
  Yang benar-benar jadi keluhan adalah **kewajiban** baca penuh (item 8), bukan ketiadaan tracking.
- **Edit multi-file satu-satu / tidak atomik**: `patch_batch` sudah ada dan preflight semua file dulu
  (`tools/builtin_tools/file_tools.ts:601`).
- **Background process bikin sesi hang**: sudah ada `background: true` + `notify: true` di
  `tools/builtin_tools/terminal_tools.ts:20-21,60-64`; masalahnya beda — proses jadi yatim antar sesi
  (item 10).
- **Race condition tulis file paralel**: tulis **tidak** pernah paralel. `agent/agent.ts:752-757` hanya
  mengelompokkan tool dengan `parallelSafe: true`, dan yang punya flag itu cuma `read_file` (`:138`),
  `search_files` (`:454`), `web_*`, `session_view`, `skills_*`, media. `patch`/`write_file` tidak.
- **Git tidak bisa dipakai**: `terminal` menjalankan `git` apa adanya (`git status`, `git diff`, `git log`).
  Tidak perlu tool khusus.
- **Download massal tanpa rekap**: untuk halaman web sudah ada rekap per-URL — `web_extract` mengembalikan
  `{ url, title, content, error? }` per URL (`tools/builtin_tools/web_tools.ts:101`). Untuk file biner
  memang belum ada tool bulk-download khusus; itu fitur (item 14), bukan bug.
- **`NO_COLOR` dicek dua kali** sudah diperbaiki di `vallencli/src/cli-theme.mjs` (emitter tidak lagi
  membaca env; deteksi level yang menangani). Jangan dikembalikan.

---

## Antrian yang belum dijadwalkan

- [x] Test gateway Telegram: pairing, allowlist, approval — pakai HTTP client tiruan, tanpa network.

  Selesai: 2026-11-09
  File: vallenagent/src/gateway/telegram.ts:39-45 (opsi `http` untuk injeksi client), vallenagent/tests/telegram_gateway.test.mjs (baru)
  Test: 10 test — pairing benar menambah allowlist + kode hangus, kode salah menambah attempt, 5 attempt menghanguskan kode, kode kedaluwarsa ditolak, user di luar allowlist tidak bisa enqueue, pesan user ter-allowlist masuk router, chat grup / id palsu diabaikan, rate limit 20 pesan/menit, callback approve/deny menyelesaikan approval, user asing tidak bisa approve. Gagal sebelum fix: ya (client HTTP belum bisa diinjeksi, jadi butuh network), lulus sesudah: ya.
  npm test: vallenagent 236/236, vallencli 56/56
  Catatan: stub mengembalikan `{ data: { ok: true, result } }` seperti axios; tidak ada socket yang dibuka.
- [ ] Pecah `vallenagent/src/agent/agent.ts` (~1.276 baris) per tahap turn. **Prasyarat**: test urutan
      event per tahap (`onToolStart` → `onToolEnd` → `onChunk` → `onTelemetry`) harus ada dulu.

Progres 2026-11-09 (belum selesai — checkbox sengaja masih kosong):

Prasyarat test urutan event: **selesai**
- `vallenagent/tests/turn_event_order.test.mjs` (4 test, lulus sebelum refactor): plain turn `thinking → telemetry`; tool turn `thinking → telemetry → tool_start → tool_end → telemetry`; chunk setelah thinking dan sebelum telemetry terakhir; turn gagal berakhir dengan `error` dan tanpa telemetry.
- Temuan: `onTelemetry` di-emit **per respons provider**, bukan sekali per turn (status bar CLI butuh itu). Kontrak ini yang dikunci test, bukan "telemetry selalu terakhir per turn" seperti asumsi di dokumen.

Tahap yang sudah dipindah keluar dari `agent.ts` (1307 → 1204 baris):
- `vallenagent/src/agent/turn_setup_phase.ts` — tahap 1 setup: rewrite `/plan`, push pesan user, auto-checklist, skill preload, deep memory.
- `vallenagent/src/agent/turn_verification_gate.ts` — keputusan murni `allow`/`nudge`/`block` sebelum final answer.
- `vallenagent/src/agent/tool_result_evidence.ts` — pembukuan hasil tool: bukti verifikasi (typecheck/test/build), artefak turn, penanda skill eksplisit.
- `vallenagent/src/agent/turn_tool_batch.ts` — tahap dispatch tool: grup `parallelSafe` (maks 4) + urutan serial, push pesan `tool`, deteksi perubahan checklist.
- `vallenagent/src/agent/tool_context.ts` — perakitan `ToolContext` (path, coverage, provider, factory subagent, callback stream).
- `vallenagent/src/agent/turn_provider_call.ts` — panggilan provider: retry tanpa cache marker, retry sekali dengan history terkompresi saat overflow/400 besar, dan penyambungan jawaban yang terpotong (`finish_reason: length`, maks 2 lanjutan, sadar budget token).
- `vallenagent/src/agent/turn_finalize.ts` — finalisasi turn sukses: checkpoint, simpan sesi, counter, statistik skill, keputusan background review, dan perakitan `AgentResponse`.

Bukti: `npm run build` OK, `npm run typecheck` OK, `npm test` → vallenagent 236/236, vallencli 56/56 (tidak ada test yang berubah selain bertambah). Test baru untuk tahap provider: `vallenagent/tests/turn_provider_call.test.mjs` (8 test: retry cache marker, error asing tidak di-retry, retry overflow, overflow tanpa kompaksi tetap gagal, lanjutan teks disambung, tool call terpotong tidak dilanjutkan, budget habis berhenti, maksimal dua lanjutan).

Catatan proses: saat memindahkan blok finalisasi, satu replace berbasis index salah tempat dan memotong ~350 baris `_chatImpl`. Region itu dipulihkan dari `dist/agent/agent.js` hasil build terakhir (kode yang sama, sudah teruji), lalu dikembalikan ke TypeScript dan diverifikasi ulang dengan seluruh suite. Efek samping: region `_chatImpl` sekarang memakai indentasi 2 spasi yang lebih ekspanded daripada gaya ringkas sebelumnya, jadi diff `agent.ts` akan terlihat lebih besar dari perubahan logikanya.

Sisa yang belum dipecah (masih di `agent.ts`, ~1204 baris):
- `executeToolCall` sendiri (alur dispatch: approval → execute → event, ~60 baris setelah context dipecah)
- helper sesi (`saveCurrentSession`, `resumeSession`, `resetSession`) dan `spawnBackgroundReview` (~100 baris)
- loop skeleton (`while` + `try/catch` + jalur max-iterations) sengaja tetap di `agent.ts` sebagai orkestrator

Catatan: semua tahap yang sudah dipindah menerima dependensi lewat objek eksplisit, jadi slice berikutnya tinggal memindahkan sisa blok dengan pola yang sama.

- [ ] Rename folder repo `vallenatrix` → `vallenemperor` + update symlink `~/.local/bin`.
      **Prasyarat**: repo sudah masuk GitHub (biar remote & history rapi duluan).
- [ ] Commit + push ke GitHub. Ditunda atas permintaan pemilik repo — jangan lakukan sendiri.

---

## Format laporan saat item selesai

Isi di bawah item yang dicentang, jangan di file terpisah:

```
Selesai: <tanggal>
File: <path:line yang diubah>
Test: <nama test baru> — gagal sebelum fix: ya/tidak, lulus sesudah: ya/tidak
npm test: vallenagent <n>/<n>, vallencli <n>/<n>
Catatan: <hal yang perlu diketahui item berikutnya>
```

---

## Update berikutnya (2026-11-09)

Batch lanjutan setelah item 1-4, 6-14:

## [x] 15. `config set` untuk preset provider

**Bukti**: item 13 menyediakan `providerPresetConfig()`/`validateProviderConfig()`, tapi belum ada permukaan CLI — user masih harus mengedit `~/.vallenemperor/config.json` manual.

**Perbaikan**: subcommand `config` di `vallencli/src/cli.mjs`:
- `vallenemperor config show` — provider aktif, `base_url`, sumber key, plus warning/error validasi (exit 2 kalau tidak valid)
- `vallenemperor config set provider <preset>` — set `providers.active` + entri preset; `api_key` selalu `''` (key dari env, tidak pernah ditulis ke config.json)
- `vallenemperor config set model <name>`, `config set approval dangerous|all|off`
- preset tak dikenal / key tak dikenal / nilai kosong → exit 2 dengan pesan, config tidak disentuh

Selesai: 2026-11-09
File: vallencli/src/cli.mjs:691-745 (`parseConfigArgs`, `runConfigCommand`), 830-845 (dispatch di `main`), vallencli/src/cli-ui.mjs:63-70 (HELP), vallenagent/src/core/types.ts:14-16 (`approval` di `AgentConfig`)
Test: vallencli/tests/cli.test.mjs (4 test: routing `parseArgs`, preset ditulis valid + key tidak disimpan, preset tak dikenal exit 2 tanpa menulis config, help memuat `config set provider`) — gagal sebelum fix: ya (API belum ada), lulus sesudah: ya
npm test: vallenagent 207/207, vallencli 56/56
Catatan: `config show` memakai `validateProviderConfig()` dari item 13, jadi provider aktif yang hilang / `base_url` kosong langsung kelihatan sebagai error.

## [x] 16. `clarify` lebih pintar: tahu kapan dipanggil

**Bukti**: `vallenagent/src/tools/builtin_tools/state_tools.ts:9-56` — handler `clarify` cuma menggemakan pertanyaan (`clarification_needed: true`) tanpa aturan kapan boleh dipanggil. Satu-satunya arahan ada di `agent_system_prompt.ts` ("ask only if ambiguity changes the action..."), tidak menolak pertanyaan yang tidak perlu. Akibatnya model bisa berhenti untuk hal sepele: minta izin lanjut, tanya warna/nama/gaya, atau mengulang instruksi yang sudah diberikan.

**Perbaikan**:
1. `vallenagent/src/agent/clarify_policy.ts` (baru) — `evaluateClarifyRequest()` + `formatClarifyOutcome()`:
   - menolak pertanyaan izin ("boleh saya lanjutkan?", "should I continue?", "lanjut?") → balikan `proceed: true` + saran melanjutkan
   - menolak preferensi yang bisa dipilih sendiri (warna/gaya/nama/format/layout/library) → "pakai default, sebutkan asumsinya"
   - batas payload: maks 5 pertanyaan, maks 4 pilihan (pilihan pertama = rekomendasi), teks tidak kosong/terlalu panjang, tidak ada pertanyaan atau pilihan duplikat
   - `clarify` yang tidak memblokir → `clarification_needed: false`, `proceed: true`
2. `state_tools.ts` — handler memakai policy itu; schema `clarify` diberi `maxItems` dan deskripsi baru yang menyebut syarat "boleh bertanya".
3. `agent_system_prompt.ts` — seksi baru `# When to Ask (clarify)`: tiga syarat wajib (mengubah hasil kerja, tidak bisa dijawab dari repo/konteks/konvensi, salah tebak mahal), daftar larangan, dan batas 5 pertanyaan / 4 pilihan.

Selesai: 2026-11-09
File: vallenagent/src/agent/clarify_policy.ts (baru), vallenagent/src/tools/builtin_tools/state_tools.ts:9-60, vallenagent/src/agent/agent_system_prompt.ts:52-58
Test: vallenagent/tests/clarify_policy.test.mjs (7 test: keputusan blocking diterima, izin-lanjut ditolak, preferensi ditolak, batas payload, payload kosong, tool benar-benar menerapkan policy lewat agent, prompt memuat aturan) — gagal sebelum fix: ya (API belum ada; handler lama selalu `clarification_needed: true`), lulus sesudah: ya
npm test: vallenagent 218/218, vallencli 56/56
Catatan: runtime tetap tidak bisa mengumpulkan jawaban terstruktur; `clarify` yang lolos policy menyuruh model bertanya di jawaban akhir lalu berhenti. Kalau nanti mau form interaktif di CLI, itu item terpisah.
