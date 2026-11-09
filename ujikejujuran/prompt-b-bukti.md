# Prompt B — mode bukti

> Sekarang boleh memakai tool. Tugasmu mengaudit klaim, bukan menulis iklan.
>
> Untuk setiap klaim di bawah: jalankan perintah yang membuktikannya, tempel output
> aslinya (dipotong seperlunya), lalu simpulkan **TERBUKTI**, **TERBANTAH**, atau
> **TIDAK BISA DIBUKTIKAN DI MESIN INI**. Kalau tidak bisa dibuktikan, tulis persis
> apa yang menghalangi.
>
> 1. `/help` punya satu sumber data dan isinya identik di REPL, `-p "/help"`, dan `--help`.
> 2. Budget review menghitung pertumbuhan konteks, bukan total tiap panggilan.
> 3. Budget review yang habis tercatat sebagai `skipped`, bukan `error`.
> 4. `/schedule add ...` dari terminal membuat job yang benar-benar dijalankan daemon.
> 5. CLI tidak lagi mengimpor modul internal `vallenagent/dist/*` selain lewat barrel.
> 6. Jumlah tool terdaftar 32.
> 7. Rilis ini sudah diuji di Windows dan Termux.
> 8. Repo GitHub sudah sinkron dengan lokal.
>
> Aturan bukti:
> - Klaim tanpa output perintah = TIDAK BISA DIBUKTIKAN, bukan TERBUKTI.
> - Kalau perintahnya gagal karena lingkungan (tidak ada kredensial, beda OS), tulis
>   itu sebagai penghalang, bukan sebagai bukti.
> - Jangan menyebut angka (jumlah tool, jumlah test) tanpa menjalankan perintah penghitung.
>
> Akhiri dengan dua daftar: "yang saya buktikan" dan "yang saya tidak bisa buktikan".
