# Experimental MF68E factory installer

The current installer is pinned to `backups/5664c9ea/preflash/emmc-full.bin`
(SHA-256 `f94da5bcaa1eaef2b9d550dd609707011fa6acf7a28687740573d2be183cb6a7`).
This fresh snapshot was captured in EDL after Android changed modem state since
the first backup. The original backup remains unchanged. Rebooting Android can
change radio state again and cause preflight to stop; keep the device in EDL
between capturing this snapshot and flashing.

This installer was prepared for **ADB serial `5664c9ea`**, EDL serial `03d861b9`,
HWID `007050e100000000`, using its verified 3,909,091,328-byte stock backup.
The factory software identifies itself as HiMI/MIFID. The retail MF68E identity
and physical PCB revision remain unconfirmed; see [device-info.md](../../device-info.md).

**The bundle has been flashed to this unit and every write verified. OpenWrt
25.12.6 boot is confirmed over SSH, its overlay mounts read/write, and the web
interface responds at http://192.168.1.1. See `device-info.md` for installation
results. Full peripheral functionality and physical recovery remain untested.**
This is an experimental boot-chain replacement, not a validated OEM installer.
Installation replaces Android system/boot and resets userdata for OpenWrt's
overlay. It also replaces primary SBL1, RPM, TrustZone, HYP and aboot. A failed
boot may require physical EDL entry to recover; software EDL entry from Android
will no longer be available. The full stock backup has not yet been restore-tested.

Creating or validating a bundle never accesses USB. `flash` is also offline by
default. Only `flash --write --device-serial 5664c9ea` writes to hardware. The
installer leaves the device in EDL after a successful flash so first boot can
be handled separately.

## What the migration does

The generated GPT uses the device's actual capacity and disk/partition UUIDs.
It keeps all stock physical partition locations except `tz`:

| New GPT number | Label | Stock storage reused |
| --- | --- | --- |
| 3 | `modem` | Original `modem`, unchanged physical offset |
| 6 | `persist` | Original `persist`, unchanged physical offset |
| 14 | `rootfs` | Original `system`, start sector 724064, 800 MiB |
| 15 | `rootfs_data` | Original `userdata`, start sector 3407872 |
| 23 | `modemst2` | Original `modemst2`, unchanged physical offset |
| 31 | `misc` | Original `misc`, unchanged physical offset |
| 8 | `tz` | 1 MiB allocation in the original unpartitioned gap, sectors 4096–6143 |
| 1 | `sbl1bak` | Original `sbl1bak`, unchanged physical offset |
| 24 | `rpm` | Original `rpm`, unchanged physical offset |

The TrustZone payload is 605312 bytes before sector padding; it does not fit in
the stock 512 KiB partition. `tzbak` and other backup bootloader partitions are
preserved but are **not a complete automatic rollback chain** for the new firmware.

The modem, modem calibration, persist, security, and recovery partitions stay at
their original physical offsets. The new rootfs and overlay numbers match the
existing OpenWrt kernel command line and preinit script. Modem/persist numbering
also matches the firmware dumper's hardcoded p3/p6 paths. The first 1 MiB of the
old userdata filesystem is zeroed so OpenWrt formats a fresh overlay at first boot.
This resets userdata logically; it is not secure erasure of the entire partition.

Write order: rootfs, boot, RPM, TrustZone, HYP, aboot, SBL1, overlay reset, backup
GPT, primary GPT. Each write must pass an independent EDL readback before the
next operation starts. The primary GPT is committed last. Power failure partway
through is not atomic or automatically recoverable.

## Build the boot firmware

Requirements: Python 3.11+, `cryptography`, git, GNU make, dtc, ARM32
`arm-none-eabi-gcc`/binutils and AArch64 binutils. The EDL environment additionally
needs [bkerler/edl](https://github.com/bkerler/edl) and its dependencies.

```bash
python3 installer/mf68e/build_bootchain.py \
  --work /tmp/mf68e-bootchain \
  --output installer-output/mf68e-firmware
```

The builder pins lk2nd, qhypstub and qtestsign commits and checks the base firmware
archive's SHA-256. It adds an MF68E node to lk1st's `msm8916-512mb-mtp` board bundle,
selects `generic,mf68e`, and enables the project's HS200 setting. It uses the
DB410c SBL1/RPM/TrustZone archive already referenced by the project's shared
firmware builder. This choice is experimental on this board; sharing the MSM8916
SoC does not establish DDR, power-management, or secure-firmware compatibility.

`--arm-prefix`, `--aarch64-prefix`, `--make` and `--jobs` override build tools.
`--base-firmware` accepts an already downloaded archive with the required hash.
`--source-root` accepts pinned source caches with subdirectories `lk2nd/`,
`qhypstub/`, and `qtestsign/`; the builder patches those source caches in place.
Source revisions and output hashes are recorded in `build-info.json`.

## Prepare and validate

The loader must be the exact RAM programmer that succeeded during backup:

```text
https://raw.githubusercontent.com/bkerler/Loaders/main/qualcomm/factory/msm8916/007050e100000000_394a2e47cf830150_fhprg_peek.bin
SHA256 53f193500c03248f0d671ab57bfe9ca8a42967e97f28403294b4b3f854075aca
```

```bash
python3 installer/mf68e/install.py prepare \
  --backup backups/5664c9ea/preflash/emmc-full.bin \
  --images bin/targets/msm89xx/msm8916 \
  --firmware installer-output/mf68e-firmware \
  --loader /tmp/mifi-msm8916-firehose.bin \
  --output installer-output/mf68e-5664c9ea

python3 installer/mf68e/install.py validate \
  --bundle installer-output/mf68e-5664c9ea \
  --backup backups/5664c9ea/preflash/emmc-full.bin
```

Preparation checks the full backup SHA-256, both GPT CRCs, firmware provenance
hashes, the OpenWrt image checksums, rootfs format, root device, payload fit, GPT
bounds and non-overlap. Validation checks bundle hashes and reconstructs the
expected migration from the backup. Output directories must be new.

## Write to the device

1. Enter EDL using `adb -s 5664c9ea reboot edl` from stock Android.
2. Find the current `05c6:9008` bus/device address with `lsusb` and grant your user
   access to that specific node, e.g. `sudo setfacl -m u:dpirek:rw /dev/bus/usb/BBB/DDD`.
   Reconnection changes the address. Do not run a second EDL client concurrently.
3. Run the explicit write command, adjusting the EDL/Python paths for the host:

```bash
python3 installer/mf68e/install.py flash \
  --bundle installer-output/mf68e-5664c9ea \
  --backup backups/5664c9ea/preflash/emmc-full.bin \
  --python /tmp/mifi-edl-venv/bin/python \
  --edl /tmp/mifi-edl/edl.py \
  --device-serial 5664c9ea --write
```

Before the first write, the installer compares the live primary/backup GPT and
the complete modemst1, modemst2, fsg and persist contents with the original backup.
These device-specific bytes establish the target identity even when an already
running Firehose loader does not print the Sahara serial. A mismatch stops the run.

The bundle records operations in `flash-journal.json` and EDL output in `flash.log`.
Existing journals prevent concurrent or accidental repeated flashing. An empty
journal means no writes started; inspect logs before retrying. A `started` entry
without `verified` means the device may be partially modified: stop and recover
instead of retrying blindly. The installer does not automatically resume or reboot.

After every operation is verified, reboot separately:

```bash
/tmp/mifi-edl-venv/bin/python /tmp/mifi-edl/edl.py reset \
  --loader=installer-output/mf68e-5664c9ea/loader.bin
```

Do not pass `--memory` to EDL's `reset` command; its command parser does not accept
that option. The first OpenWrt boot may format overlay and reboot again.

## Recover stock firmware

Keep the backup and tested loader on the host before starting. If boot fails,
regain EDL access; this may require the board's physical test pads or an EDL cable.
No physical EDL entry method has been tested on this particular unit.

Verify the stock backup, then use EDL's full-image write (not the shared UZ801 flasher):

```bash
cd backups/5664c9ea/preflash
sha256sum -c SHA256SUMS
cd ../../..
/tmp/mifi-edl-venv/bin/python /tmp/mifi-edl/edl.py wf \
  backups/5664c9ea/preflash/emmc-full.bin --memory=emmc \
  --loader=installer-output/mf68e-5664c9ea/loader.bin
```

This rewrites the entire eMMC user area, including both stock GPTs, bootloaders,
Android, and userdata. Read the entire device back with `rf` into a **different**
file and compare its SHA-256 to the original before rebooting. EDL restores do
not restore SoC fuses or RPMB. Never overwrite the original backup with a readback.

## Offline tests

```bash
python3 -m unittest discover -s installer/mf68e -p 'test_*.py' -v
```

Tests use a sparse synthetic eMMC image and simulated EDL. They cover physical
radio-partition preservation, GPT geometry/CRC handling, successful write/readback
ordering, wrong-device rejection, corrupted payload rejection, redirected writes,
failure before subsequent bootloader/GPT writes, and default offline behavior.
They validate installer logic, not hardware boot compatibility.
