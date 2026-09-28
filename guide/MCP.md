# MCP

`node dist/cli.js mcp` menjalankan server stdio. `install` mendaftarkannya untuk agen yang dipilih. Stdout proses ini hanya berisi protokol MCP.

Tool baca: `list_turns`, `diff_turn`, `status`. Tool tulis: `restore`, `redo`. Semua menerima `workspace` opsional. `restore` menerima `target` (ID giliran atau ref snapshot) dan `paths` opsional; `redo` memakai snapshot pengaman restore terakhir. Panggilan pertama tanpa `token` mengembalikan rencana dan `confirm_token`. Panggilan kedua mengirim token itu sebagai `token`. Server memeriksa ulang rencana di bawah lock sebelum menulis.

```json
{"name":"restore","arguments":{"target":"<turn-id>","workspace":"/path/to/project"}}
{"name":"restore","arguments":{"target":"<turn-id>","workspace":"/path/to/project","token":"<confirm_token>"}}
```

Untuk file yang mungkin diedit pengguna, server menggunakan mekanisme `inputRequired` SDK MCP v2 ketika klien mengiklankan dukungan elicitation. Jika klien tidak mendukungnya atau persetujuan ditolak, file tersebut dilewati dan CLI disarankan. Lihat [SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) dan [migrasi protokol 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).
