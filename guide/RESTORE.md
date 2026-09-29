# Restore

`turnback list` shows turn IDs. `turnback diff <id>` shows the changes from the baseline to the turn's last snapshot. Preview with `turnback restore <id> --dry-run`; select files with a repeated `--path src/file.ts`. Apply with `--yes`. `turnback undo --yes` picks the most recent turn not yet undone. `turnback redo --yes` uses the safety snapshot taken before the last restore. A new agent turn starts a new history: the next undo targets that turn, and earlier undos can no longer be redone.

In `edits-only` mode (`scope: recorded-paths` in the preview), restore touches only paths recorded by edit hooks since the target point; other files are left alone.

Before writing anything, Turnback takes a safety snapshot. Files are rewritten as their original bytes, including BOM and CRLF. Files created by the agent are deleted when restoring to the baseline; files deleted by the agent are recreated. Executable bits and symlinks are restored when the OS allows. If a file fails to write, the CLI exits with code 1 and lists the failures.

MCP tokens are bound to the target, the selected paths, and a hash of the workspace state. Stale tokens are rejected under the lock. Without direct approval support from the MCP client, files that may have been edited manually are skipped; use the CLI to inspect and restore them. After a restore, start a new agent conversation or tell the agent that the files have changed.
