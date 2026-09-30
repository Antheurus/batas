# batas Changelog

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
