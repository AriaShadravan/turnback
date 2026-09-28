# Cakupan dan batas

- Snapshot hanya mencakup filesystem pada root workspace. Efek jaringan, database, proses, file di luar root, dan konteks percakapan agen tidak dipulihkan.
- File di atas 5 MB serta `.git`, `.turnback`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `target`, `.next`, `.nuxt`, `.cache`, `coverage`, `.turbo`, dan `.gradle` dikecualikan. Tambahkan pola di `.turnbackignore`.
- Hook tidak memblokir tool agen. Kegagalan baseline dapat membuat giliran `unprotected`; lihat `turnback status` sebelum memulihkan.
- Restore hanya menulis file dalam cakupan snapshot. File besar, direktori yang dikecualikan, dan symlink parent yang mengarah keluar workspace tidak ditimpa.
- Shadow repo terpisah dari `.git` pengguna, tetapi menyimpan salinan file sensitif kecil seperti `.env`. Lindungi direktori `~/.turnback` sesuai kebutuhan mesin Anda.
- Latensi bergantung pada disk, Git, dan banyak file. Benchmark 10 ribu file dilaporkan CI. Baseline awal dijalankan di latar belakang; giliran ditandai `unprotected` bila menunggu baseline lebih dari 30 detik.
