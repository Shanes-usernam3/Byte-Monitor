# Third-party notices

Byte Monitor is © HardPoint Networks and covered by [LICENSE](LICENSE). It includes
the third-party software below, each under its own license. Those licenses apply
to those components only, and nothing in Byte Monitor's license restricts them.
Full license texts are in the [`licenses/`](licenses) folder, and every build ships
them in its `resources/licenses` folder.

## In every build (Windows and Linux)

| Component | License | Source |
|---|---|---|
| Electron (includes Chromium and Node.js) | MIT; Chromium's licenses are listed in `LICENSES.chromium.html` next to the app | https://github.com/electron/electron |
| systeminformation | MIT | https://github.com/sebhildebrandt/systeminformation |

## Windows builds only

| Component | License | Source |
|---|---|---|
| **smartctl** (from smartmontools) — `resources/smartctl/smartctl.exe` | **GPL-2.0** | https://github.com/smartmontools/smartmontools · https://www.smartmontools.org |
| **byte-sensors.exe** — Byte Monitor's sensor helper. The helper's own code (`sensors-helper/`) is © HardPoint Networks under [LICENSE](LICENSE); it is built with: | | |
| ↳ LibreHardwareMonitorLib 0.9.6 (unmodified) | MPL-2.0 | https://github.com/LibreHardwareMonitor/LibreHardwareMonitor |
| ↳ PawnIO.Modules (embedded in LibreHardwareMonitorLib) | LGPL-2.1 | https://github.com/namazso/PawnIO.Modules |
| ↳ DiskInfoToolkit | MPL-2.0 | https://github.com/Blacktempel/DiskInfoToolkit |
| ↳ RAMSPDToolkit | MPL-2.0 | https://github.com/Blacktempel/RAMSPDToolkit |
| ↳ HidSharp | Apache-2.0 (see `NOTICE-HidSharp.txt`) | https://github.com/IntergatedCircuits/HidSharp |
| ↳ Mono.Posix | MIT | https://github.com/mono/mono.posix |
| ↳ .NET runtime and libraries (self-contained) | MIT | https://github.com/dotnet/runtime |
| **PawnIO driver setup** — `resources/sensors/PawnIO_setup.exe`, unmodified, only run when you click *Enable CPU temps & fans* | **GPL-2.0-or-later** (with linking exception) | https://github.com/namazso/PawnIO · releases: https://github.com/namazso/PawnIO.Setup |

### GPL / LGPL / MPL source availability

smartctl and the PawnIO driver are separate programs that Byte Monitor runs; they
are not linked into Byte Monitor. They are distributed unmodified. Their complete
corresponding source code is available from the links above, and the exact
smartctl version is recorded in `resources/smartctl/NOTICE.txt` in each build. If a
link stops working, open an issue on this repository and the matching source will
be provided for at least three years after the release that included it.

LibreHardwareMonitorLib, PawnIO.Modules, DiskInfoToolkit and RAMSPDToolkit are
used unmodified; their source is available at the links above.

## Trademarks

HWMonitor, HWiNFO, WizTree, LibreHardwareMonitor, Windows and other product names
mentioned in this repository belong to their owners. Byte Monitor is an independent
product and is not affiliated with or endorsed by them.
