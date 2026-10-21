# Byte Monitor

Desktop hardware health monitor for **Windows and Linux** — a cleaner, simpler HWMonitor in the Byte theme, plus a WizTree-style space analyzer. Built for quick device health checks (HardPoint Networks).

## What it shows
- **Overview** — one health score (0–100) with what's behind it, CPU/GPU temps, memory, live CPU chart, per-core load, fans
- **Sensors** — every sensor with **current / min / max** (HWMonitor-style), reset button
- **Storage** — each drive's health %, SMART status, temperature, power-on hours, power cycles, SSD life used, reallocated/pending sectors, media errors; volume usage
- **Space** — WizTree-style scan of any drive or folder: nested treemap (click to drill in, right-click to go up), biggest items, largest 100 files, space by file type. Read-only — nothing is ever deleted.
- **Battery** — designed max capacity vs current max capacity, **% capacity left**, wear, cycles, voltage
- **System** — make/model, OS, CPU, GPUs, RAM modules
- **Save health report** — exports a clean HTML report (handy for customer jobs)

## Run it
```bash
npm install
npm start          # real sensors
npm run demo       # fake data, for UI work on a VM
```

## Build installers
```bash
npm run dist:win     # dist/Byte Monitor Setup x.y.z.exe + portable .exe   (run on Windows)
npm run dist:linux   # dist/*.AppImage + *.deb                            (run on Linux)
```
Or push a tag (`git tag v0.1.0 && git push --tags`) / run the **Build Byte Monitor** workflow in GitHub Actions — it builds both and attaches them as artifacts.

## Getting full sensor data
| Data | Windows | Linux |
|---|---|---|
| Drive SMART detail | Install **smartmontools** (`winget install smartmontools.smartmontools`). App runs as admin automatically. | `sudo apt install smartmontools` (the .deb pulls it in). Run with `sudo` or SMART detail is limited. |
| CPU temps & fans | Run **LibreHardwareMonitor** in the background (Options → Run on startup). Byte Monitor reads it automatically. Without it, Windows only reports ACPI temps (often blank). | `sudo apt install lm-sensors && sudo sensors-detect` |
| GPU (NVIDIA) | Works via `nvidia-smi` (ships with the driver) | Same |
| Battery | Built in | Built in |

## Health scoring
- **Battery**: current max ÷ designed max. 80%+ Good · 60–80% Fair · <60% Replace soon
- **Drives**: starts at 100, capped by SSD life remaining, minus reallocated/pending sectors and media errors; SMART failure drops it to ≤10
- **CPU temp**: <75°C full marks, 75–85 slight, 85–92 warning, 92+ attention

## Project layout
```
src/main.js            Electron main process, IPC, report saving, space-scan control
src/sensors.js         Hardware layer (systeminformation + LibreHardwareMonitor/hwmon extras)
src/scanner-worker.js  Disk space scanner (worker thread, stays on one drive, skips symlinks)
src/demo.js            Fake data for --demo
src/renderer/          UI (index.html, styles.css, app.js, space.js) — no framework
```
