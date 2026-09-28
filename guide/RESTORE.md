# Pemulihan

`turnback list` menampilkan ID giliran. `turnback diff <id>` menampilkan perubahan dari baseline sampai snapshot terakhir giliran. Pratinjau dengan `turnback restore <id> --dry-run`; pilih file dengan `--path src/file.ts` berulang. Terapkan dengan `--yes`. `turnback undo --yes` memilih giliran terbaru yang belum di-undo. `turnback redo --yes` memakai snapshot pengaman sebelum restore terakhir.

Pada mode `edits-only` (`scope: recorded-paths` di pratinjau), restore hanya menyentuh path yang pernah dicatat hook edit sejak titik target; file lain dibiarkan.

Sebelum penulisan apa pun Turnback mengambil snapshot pengaman. File ditulis ulang sebagai byte asli, termasuk BOM dan CRLF. File yang dibuat agen dihapus saat restore ke baseline; file yang dihapus agen dibuat lagi. Bit eksekusi dan symlink dipulihkan bila OS mengizinkan. Jika file gagal ditulis, CLI keluar dengan kode 1 dan menampilkan daftar gagal.

Token MCP terikat pada target, path yang dipilih, dan hash keadaan workspace. Token basi ditolak di bawah lock. Tanpa dukungan persetujuan langsung dari klien MCP, file yang mungkin diedit manual dilewati; gunakan CLI untuk memeriksa dan memulihkannya. Setelah restore, mulai percakapan agen baru atau beri tahu agen bahwa file telah berubah.
