# batas Changelog

## v0.7.0 — Aturan Step 5b dijaga langsung saat menulis

- Kalau agent menulis memory tanpa baris `triggers:`, batas langsung memperingatkan dan menunjukkan formatnya. Memory baru tidak perlu backfill lagi.
- Saat file aturan gotcha/lessons diedit pertama kali di sebuah sesi, batas menampilkan checklist: entri triggers.toml dan teks lengkap di *-full.md.
- `status` sekarang juga menampilkan aturan always-on yang belum punya teks lengkap. Hari ini 0 dari 91.

## v0.6.2 — Sesi yang sudah terbuka tidak lagi terblokir oleh kerjaannya sendiri

- Waktu mulai sesi sekarang diambil dari waktu transcript-nya dibuat, bukan dari saat batas pertama kali melihat sesi itu. Sesi yang sudah terbuka sebelum update ini tidak lagi menganggap kerjaannya sendiri sebagai "bukan milik sendiri".
- Pesan blok sekarang menyuruh stage per file terlebih dahulu. ACK hanya untuk kasus yang benar-benar sudah dicek.
- Setiap ACK yang benar-benar melewati blok dicatat dan dihitung di `status`, jadi kebiasaan asal ACK kelihatan.

## v0.6.1 — Penjaga sesi bentrok juga melihat edit lewat script

- File yang diubah lewat perintah Bash atau script (python, sed, redirect) sekarang tercatat sebagai milik sesi yang menjalankannya, jadi `git add -A` di sesi lain tetap diblokir kalau akan menyapu file itu.
- File yang sudah kotor sebelum sesi dimulai dianggap bukan kerjaan sesi itu, sehingga kerjaan lama yang belum di-commit juga terlindungi.
- Pesan blok sekarang menyebut alasan tiap file: "written by another session" atau "dirty before this session started".
- Ada tambahan hook kecil setelah setiap perintah Bash, sekitar 35 ms.

## v0.6.0 — Penjaga sesi bentrok sekarang memblokir, bukan cuma memperingatkan

- `git add -A`, `git add .`, `commit -a`, `stash` tanpa path, `checkout .`, `restore .`, `reset --hard`, dan `clean -f` sekarang DIBLOKIR kalau repo masih punya file belum di-commit yang ditulis sesi Claude lain. Sesi yang sedang diam juga terdeteksi. Pesan bloknya menyebut file-file tersebut.
- `git push` DIBLOKIR selama ada sesi lain yang aktif di repo yang sama dalam 15 menit terakhir.
- Selalu ada jalan keluar: stage per path, atau setelah dicek tambahkan `BATAS_ACK_FOREIGN=1` (untuk sapu bersih) atau `BATAS_ACK_LIVE=1` (untuk push) di depan perintahnya.
- Perintah yang cuma menyebut `git add -A` di dalam tanda kutip atau script tidak ikut diblokir.

## v0.5.0 — Penjaga sesi bentrok, aturan dipilah pakai data, dan bukti batas bekerja

- Kalau ada sesi Claude lain yang aktif di repo yang sama dalam 15 menit terakhir, agent diberi peringatan sebelum menjalankan perintah git yang mengubah isi repo (commit, push, add, stash, reset, dan lain-lain).
- 11 aturan yang jarang terpakai dan tidak berbahaya dipindahkan dari rules yang selalu dimuat ke mode "dikirim saat relevan". Aturan yang bersifat merusak tetap selalu dimuat, karena kiriman batas baru tiba setelah perintahnya jalan.
- Perintah baru `just effect-audit` membandingkan perilaku agent sebelum dan sesudah batas aktif. Contohnya, kesalahan `| head && echo` turun dari 50% ke 19% sesi, sementara aturan pembanding seperti `git push` tetap datar.
- Daftar rencana lengkap (9 item) ada di `docs/roadmap.md`.

## v0.4.1 — "batas nyasar" sekarang mengenai yang benar

- "batas nyasar" sekarang hanya membisukan memory yang dikirim di prompt terakhirmu, bukan aturan yang muncul dari perintah agent (misalnya aturan git push).
- Kata "batas nyasar" di dalam catatan side agent atau kutipan (`>`) tidak lagi dianggap sebagai teguranmu.
- Satu laporan salah yang sempat tercatat akibat bug ini sudah dihapus.

## v0.4.0 — batas lebih cepat, bisa ditegur, dan kelihatan kalau rusak

- Kalau batas mengirim aturan atau memory yang nyasar, cukup bilang "batas nyasar" (atau salah/ngaco/keliru). Isinya langsung dibisukan sampai sesi selesai dan laporanmu dicatat. Untuk membisukan selamanya, agent bisa memakai tool `mute`.
- Pengecekan memory di setiap prompt sekarang sekitar 42 ms, sebelumnya 252 ms.
- Error di hook batas sekarang tercatat dan ditampilkan di `status`. Log hook juga dirotasi otomatis (5 MB × 3 file), jadi tidak lagi membengkak terus.
- Perintah baru `just rule-audit` mengecek trigger setiap aturan terhadap ~64 ribu perintah asli dari transcript 14 hari terakhir, untuk menemukan trigger yang mati atau terlalu sering muncul.
- `just check` sekarang juga gagal kalau hook jadi lambat (anggaran 60 ms per tool call dan 150 ms per prompt, diuji dengan skala ~600 memory).

## v0.3.0 — Memory datang sendiri, rules datang lengkap

- Kalau permintaanmu nyambung dengan sebuah memory di project itu, isi lengkap memory tersebut langsung dikirim ke agent (maksimal 2, sekali per sesi), tanpa perlu dicari dulu.
- Saat sebuah aturan gotcha/lessons terpicu oleh perintah atau file, agent sekarang menerima teks aslinya yang lengkap, bukan versi ringkas yang sudah ada di konteks.
- Perintah baru `just memory-index` memendekkan baris di setiap MEMORY.md (dry run dulu; `just memory-index apply` menulis dan menyimpan backup di ~/.batas/memory-index-backup). Total semua index turun dari 116k jadi 81k karakter.
- Memory baru yang dicatat lewat batas otomatis memakai baris index yang pendek.

## v0.2.0 — Petunjuk alat, dan asal-usul setiap catatan

- Kalau kamu bilang "inget ya", "catat ke progress", "pernah kejadian gini?" atau "mau hapus branch lama", agent
  langsung diberi tahu tool batas mana yang harus dipakai.
- Setiap memori dan aturan baru sekarang mencatat siapa yang memulainya: kamu yang minta, agent yang berinisiatif
  sendiri, atau kamu yang menulis sendiri. Info ini ikut tampil setiap kali aturan itu muncul.
- Laporan dari agent latar belakang tidak lagi dianggap sebagai ketikan kamu.

## v0.1.2 — Command yang cuma menyebut pola tidak memicu aturan lagi

- Aturan tidak lagi muncul hanya karena sebuah command *menyebut* pola berbahaya di dalam tanda kutip. Contohnya
  pesan commit yang bilang "jangan pernah git reset --hard".
- Kode yang benar-benar dijalankan, misalnya lewat `bash -c`, `python3 -c`, `ssh server "…"` atau
  `playwright-cli eval`, tetap dicek seperti biasa.

## v0.1.1 — Jawaban yang cuma mengutip kesalahan tidak ditahan lagi

- Kalau agent cuma *mengutip* kalimat yang salah, misalnya sebagai contoh atau bukti tes, jawabannya tidak ditahan
  lagi. Yang ditahan hanya jawaban yang benar-benar mengulang kesalahan itu.

## v0.1.0 — Batas pertama: aturan muncul sendiri saat dibutuhkan

- Waktu agent mau menjalankan command atau mengedit file yang pernah bikin masalah, aturan yang relevan langsung
  muncul di konteksnya. Agent tidak perlu ingat sendiri.
- Kalau jawaban akhir agent mengulang kesalahan yang sudah tercatat, jawabannya ditahan sekali supaya diperbaiki.
  Contohnya menanyakan "mau saya commit?", menyarankan tool yang dulu sudah ditolak, atau menyuruh kamu menjalankan
  command yang bisa dia jalankan sendiri.
- Agent bisa mencari di semua catatan lewat MCP `batas`: rules, catatan insiden, memori preferensi kamu, dan
  progress/changelog semua repo. Dia juga bisa menyimpan memori baru, dan menulis progress/changelog yang otomatis
  menolak nomor versi dobel.
- Rule global tidak pernah ditulis otomatis. batas cuma menyiapkan draf, beserta rule lain yang mirip.
- Pemasangan: `just install` di repo batas. Tidak ada langkah tambahan, dan hook-nya aktif di sesi baru.
