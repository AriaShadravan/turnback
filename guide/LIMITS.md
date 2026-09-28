# Scope and limits

- Snapshots cover only the filesystem under the workspace root. Network effects, databases, processes, files outside the root, and the agent's conversation context are not restored.
- Files above 5 MB and `.git`, `.turnback`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `target`, `.next`, `.nuxt`, `.cache`, `coverage`, `.turbo`, and `.gradle` are excluded. Add patterns in `.turnbackignore`.
- Workspaces above 100k files or 2 GB switch to `edits-only` mode. Only paths touched by edit tools are snapshotted; shell commands are not protected and are recorded as `unprotected`. Restore in this mode touches only recorded paths, using each path's content from just before it was first changed after the target point.
- Hooks never block agent tools. A failed baseline can leave a turn `unprotected`; check `turnback status` before restoring.
- Restore writes only files within snapshot scope. Large files, excluded directories, and parent symlinks pointing outside the workspace are never overwritten.
- The shadow repo is separate from the user's `.git`, but it stores copies of small sensitive files such as `.env`. Protect the `~/.turnback` directory as your machine requires.
- If a snapshot fails because the shadow repo is corrupt (missing objects, unreadable index, not a repository), the repo and its journal are moved to `corrupt-<time>/` in the workspace data folder and a new baseline is taken. Turns recorded before that can no longer be restored. `turnback status` lists these folders under `corrupt`; they are never deleted automatically. Corruption is only detected when a snapshot has to write objects.
- Latency depends on disk, Git, and file count. CI reports a 10k-file benchmark. The initial baseline runs in the background; a turn is marked `unprotected` if it waits more than 30 seconds for the baseline.
