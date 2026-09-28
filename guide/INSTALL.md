# Pemasangan

Jalankan `npm ci && npm run build`, lalu `node dist/cli.js install all` untuk konfigurasi pengguna atau tambahkan `--project` untuk repo saat ini. Pilih salah satu `claude`, `codex`, `gemini`, `cursor` untuk satu agen. Jalankan `uninstall` dengan level yang sama untuk melepas entri Turnback. Pemasangan berulang tidak menggandakan hook.

Hook memanggil `node <path absolut>/dist/cli.js hook <agen>` dan server MCP memanggil `node <path absolut>/dist/cli.js mcp`. Jaga lokasi hasil build setelah pemasangan. Setelah mengubah kode, jalankan `npm run build` lagi. Restart agen agar konfigurasi terbaca. Codex juga meminta peninjauan kepercayaan hook baru melalui `/hooks`.

Lokasi konfigurasi:

| Agen | Hook proyek | Hook pengguna | MCP |
|---|---|---|---|
| Claude Code | `.claude/settings.json` | `~/.claude/settings.json` | `.mcp.json` / `~/.claude.json` |
| Codex | `.codex/hooks.json` | `~/.codex/hooks.json` | `.codex/config.toml` / `~/.codex/config.toml` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` | `mcpServers` pada settings yang sama |
| Cursor | `.cursor/hooks.json` | `~/.cursor/hooks.json` | `.cursor/mcp.json` / `~/.cursor/mcp.json` |

Format hook diverifikasi dari [Claude Code](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/reference/), dan [Cursor](https://prod.cursor.com/docs/hooks). Codex menyediakan `turn_id`; Gemini memerlukan ID giliran lokal per sesi. Cursor harus menerima JSON izin yang valid pada hook izin, sehingga Turnback mengembalikan `{"permission":"allow"}`.
