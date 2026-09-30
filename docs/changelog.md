# batas Changelog

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
