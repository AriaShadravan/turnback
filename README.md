# Turnback

Turnback merekam keadaan file sebelum dan selama giliran agen coding, lalu memulihkannya lewat CLI atau MCP. Shadow Git disimpan di `~/.turnback` (atau `TURNBACK_HOME`), terpisah dari `.git` proyek.

Mendukung Claude Code, Codex, Gemini CLI, dan Cursor. Membutuhkan Node.js 22+ dan Git 2.25+. Versi ini adalah source package; publikasi npm belum dilakukan.

```bash
npm ci
npm run build
node dist/cli.js install all --project
node dist/cli.js list
node dist/cli.js diff <turn-id>
node dist/cli.js undo --dry-run
node dist/cli.js undo --yes
```

`install all` tanpa `--project` memasang konfigurasi pada level pengguna. `uninstall all [--project]` hanya menghapus entri Turnback. `--no-mcp` memasang hook tanpa MCP. Konfigurasi lain dipertahankan.

Perintah tersedia: `install`, `uninstall`, `list`, `diff`, `status`, `restore`, `undo`, `redo`, `gc`, dan `mcp`. `restore <turn> --path <file> --dry-run` menampilkan rencana. `--yes` menerapkannya. `redo --yes` kembali ke snapshot pengaman sebelum pemulihan terakhir. Pemulihan mengubah file proyek; konteks percakapan agen tidak ikut dipulihkan.

Dokumentasi: [pemasangan](guide/INSTALL.md), [pemulihan](guide/RESTORE.md), [MCP](guide/MCP.md), dan [cakupan](guide/LIMITS.md).

## Cara kerja

Hook sebelum tool pengubah mengambil baseline giliran. Hook sebelum shell menangkap seluruh tree; edit berikutnya menangkap path terkait. Akhir giliran menangkap hasilnya. Snapshot awal dipanaskan di latar belakang saat pemasangan dan awal sesi. Hook selalu memberi izin agen melanjutkan saat perekaman gagal; status `failed`, `skipped`, atau `unprotected` terlihat lewat `status`.

File tracked, untracked, dan gitignored hingga 5 MB dicakup. Direktori hasil build dan dependensi dikecualikan. Aturan tambahan mengikuti sintaks gitignore di `.turnbackignore`; aturan global berupa `{"exclude":["pattern"]}` di `~/.turnback/config.json`.

Workspace di atas 100 ribu file atau 2 GB masuk mode `edits-only`: hanya path yang disentuh tool edit yang di-snapshot, perintah shell dicatat sebagai `unprotected`, dan restore hanya menyentuh path yang tercatat. Giliran yang lebih tua dari 7 hari dan di luar 50 giliran terakhir dibersihkan otomatis paling sering sekali sehari.

## Pengembangan

| Modul | Isi |
|---|---|
| `src/cli.ts` | Titik masuk CLI dan hook |
| `src/adapters.ts` | Payload hook tiap agen → `HookEvent` |
| `src/recorder.ts` | Aturan snapshot per event |
| `src/store.ts` | Journal, snapshot, riwayat giliran, status, `gc` |
| `src/restore.ts` | Rencana dan eksekusi restore, undo, redo |
| `src/shadow.ts` | Pembungkus shadow repo git |
| `src/workspace.ts` | Pemindaian workspace dan aturan pengecualian |
| `src/journal.ts`, `src/lock.ts`, `src/config.ts` | Journal JSONL, lock per workspace, konstanta |
| `src/install.ts` | Pemasangan hook dan MCP per agen |
| `src/mcp.ts` | Server MCP stdio |

```bash
npm run check
npm run bench
```

Benchmark membuat repo sementara 10 ribu file dan melaporkan latensi, tanpa menjadikannya gerbang CI yang kaku. CI menjalankan tes dan benchmark pada Windows, macOS, Linux × Node 22/24.
