# Device information

## Identification and confidence

These findings come from the connected device, its full eMMC backup, and the
project sources. The retail model and physical PCB revision are **not confirmed**.
MF68E is the intended OpenWrt target, not an identity conclusively reported by
this device.

| Item | Observed value | Evidence |
| --- | --- | --- |
| SoC | Qualcomm MSM8916 | EDL hardware identification and Android properties |
| EDL HWID | `0x007050e100000000` | Sahara handshake |
| ADB serial | `5664c9ea` | ADB enumeration |
| EDL serial | `0x03d861b9` | Sahara handshake |
| Runtime branding | `MIFID` | Android product/model/manufacturer properties |
| Factory system branding | `HiMI`, `HiMI_MIFI` | Backed-up system partition `/build.prop` |
| Android version | 4.4.4 | Runtime and backed-up build properties |
| Build | `msm8916_32_512-userdebug`, `eng.edwin.20250727`, test keys | Runtime build properties |
| Reported revision | `ro.revision=0` | Runtime property; not a verified PCB revision |
| eMMC capacity | 3,909,091,328 bytes (7,634,944 sectors) | Android sysfs and EDL |
| Logical sector size | 512 bytes | Android sysfs and successful EDL reads |
| Android USB ID | `05c6:9024` | Host USB enumeration |
| EDL USB ID | `05c6:9008` | Host USB enumeration |

OpenWrt reports `MemTotal: 391204 kB` (usable RAM after reservations). Physical
RAM capacity has not been independently established; the `512` build name and
bundled 512MB board definitions are not measurements of installed RAM.

## Display and device-tree evidence

The backed-up OEM boot partition contains **23 valid flattened device trees**,
including definitions for several Qualcomm boards and SoCs. Their presence does
not establish which tree the bootloader selected on this device.

The MSM8916 MTP definitions include:

- GC9107 SPI display, 128 x 128 pixels.
- Display reset on GPIO 11.
- Display data/command on GPIO 30.
- Generic MSM8916 MTP board IDs `<0x08 0x00>` and `<0x08 0x100>` for the
  normal and 512MB MTP definitions respectively; the active board ID is unconfirmed.

The panel and GPIO assignments match the project's MF68E device-tree patch,
`msm89xx/patches/802-arm64-dts-qcom-add-msm8916-generic-mf68e.patch`.
This supports compatibility but does not prove the retail model or PCB revision.

## Access and backup

- ADB shell works as UID 2000. Standalone `su` is absent.
- `adb root` returns `password error`; no root password is available.
- The stock Android environment reported SELinux `Permissive`.
- `adb reboot edl` successfully enters Qualcomm EDL mode.
- The following RAM programmer successfully read the stock GPT and full eMMC:
  `qualcomm/factory/msm8916/007050e100000000_394a2e47cf830150_fhprg_peek.bin`
  from [bkerler/Loaders](https://github.com/bkerler/Loaders).
- Host USB access required an ACL for the current `/dev/bus/usb/BBB/DDD` node.
  That node changes when the device reconnects, so the ACL must be reapplied
  unless a persistent host rule is configured.

Backup directory: `backups/5664c9ea/`.

| Artifact | Description |
| --- | --- |
| `emmc-full.bin` | Full eMMC user-area image, including all 31 GPT partitions |
| `backup-manifest.json` | Capacity, partition offsets, hashes, verification results |
| `SHA256SUMS` | SHA-256 hashes for the full image and extracted partitions |
| `partitions/` | 20 extracted recovery/bootloader/radio partitions |
| `gpt-primary-readback.bin` | Independent reread of sectors 0–33 |
| `device-info.txt` | Runtime properties and stock partition information |
| `backup.log`, `readback.log` | EDL read logs |

Full-image SHA-256:

```text
0c93de7d55b505d6e533ce7c6a1b16d1a4365a3872eb889947c04cbb6beaf478
```

Verification completed:

- Exact image size matches the device's 7,634,944 sectors.
- Primary and backup GPT header and partition-entry CRCs pass.
- Both GPT partition-entry arrays match.
- An independent read of the primary GPT matches the corresponding backup bytes.

This is an eMMC user-area backup; it is not a dump of SoC fuses or RPMB.
Restoring the full image has not been tested. Keep backups private: they include
userdata and device-specific radio configuration. Do not commit backup images.

## Stock partition layout

Start and length are in 512-byte sectors, as verified from the backup GPT.

| Partition number | Label | Start sector | Sector count |
| --- | --- | --- | --- |
| 1 | `modem` | 131072 | 131072 |
| 2 | `sbl1` | 262144 | 1024 |
| 3 | `sbl1bak` | 263168 | 1024 |
| 4 | `aboot` | 393216 | 2048 |
| 5 | `abootbak` | 395264 | 2048 |
| 6 | `rpm` | 524288 | 1024 |
| 7 | `rpmbak` | 525312 | 1024 |
| 8 | `tz` | 526336 | 1024 |
| 9 | `tzbak` | 527360 | 1024 |
| 10 | `hyp` | 528384 | 1024 |
| 11 | `hypbak` | 529408 | 1024 |
| 12 | `pad` | 530432 | 2048 |
| 13 | `modemst1` | 532480 | 3072 |
| 14 | `modemst2` | 535552 | 3072 |
| 15 | `misc` | 538624 | 2048 |
| 16 | `fsc` | 540672 | 2 |
| 17 | `ssd` | 540674 | 16 |
| 18 | `splash` | 540690 | 20480 |
| 19 | `DDR` | 655360 | 64 |
| 20 | `fsg` | 655424 | 3072 |
| 21 | `sec` | 658496 | 32 |
| 22 | `boot` | 658528 | 65536 |
| 23 | `system` | 724064 | 1638400 |
| 24 | `persist` | 2490368 | 65536 |
| 25 | `keystore` | 2555904 | 1024 |
| 26 | `cache` | 2556928 | 524288 |
| 27 | `config` | 3081216 | 1024 |
| 28 | `recovery` | 3145728 | 65536 |
| 29 | `devinfo` | 3211264 | 2048 |
| 30 | `oem` | 3276800 | 131072 |
| 31 | `userdata` | 3407872 | 4227039 |

## OpenWrt image and installation status

The project contains these images under `bin/targets/msm89xx/msm8916/`:

- `openwrt-msm89xx-msm8916-generic-mf68e-squashfs-boot.img`
- `openwrt-msm89xx-msm8916-generic-mf68e-squashfs-system.img`
- `openwrt-msm89xx-msm8916-generic-mf68e-squashfs-sysupgrade.bin`

Their checksums matched the supplied `sha256sums`. Hardware validation of these
images has established that OpenWrt boots, SSH and HTTP respond, and the overlay mounts
read/write. Full display, Wi-Fi and cellular functionality has not been verified.

The boot image requests `root=/dev/mmcblk0p14`; the OpenWrt preinit script uses
`/dev/mmcblk0p15` for `rootfs_data`. On the stock device these numbers refer to
`modemst2` and `misc`. Writing rootfs to stock partition 14 or formatting stock
partition 15 is not a valid installation procedure. The rootfs image is also
larger than the stock `modemst2` partition.

The existing shared GPT generator uses a different total capacity (7,569,408
sectors). The shared firmware builder selects the UZ801 compatible string
`yiming,uz801-v3`. The MF68E build deliberately omits that GPT, firmware ZIP,
and flasher because they are not an MF68E OEM installation bundle.

An experimental installer and boot firmware have now been built under
`installer/mf68e/` and `installer-output/`. See
[installer instructions](installer/mf68e/README.md) for build, validation,
flashing, and stock recovery commands. The generated layout reuses stock system
and userdata storage for rootfs/overlay, reorders GPT entries while preserving
radio data at its original offsets, and moves TrustZone into an unused gap.

The bootloader selects `generic,mf68e` using the `msm8916-512mb-mtp` lk1st board
bundle. The firmware builds successfully and the installer passes offline
validation against the real backup and simulated EDL safety tests. The firmware
and partition migration were subsequently flashed, with OpenWrt boot confirmed
as recorded below. Full peripheral functionality remains unverified.

## Installation result

The experimental firmware has now been flashed. All ten payload/GPT writes passed
independent EDL readback verification. Post-flash reads of modemst1, modemst2, fsg,
persist, fsc and sec match the fresh preflash backup exactly.

Android changed modem state after the initial backup, so installation used a fresh
verified snapshot taken in EDL without booting Android again:
`backups/5664c9ea/preflash/emmc-full.bin` (3,909,091,328 bytes).
Its SHA-256 is
`f94da5bcaa1eaef2b9d550dd609707011fa6acf7a28687740573d2be183cb6a7`.
The original backup remains unchanged.

**OpenWrt boot is confirmed.** After approximately 74 seconds the device
reappeared as `1d6b:0104` (Linux USB Gadget / CDC NCM). The host obtained
`192.168.1.141/24` by DHCP. SSH reports:

- OpenWrt 25.12.6, revision `r33311-981c978eff`.
- Kernel `6.12.112`, board `generic,mf68e`.
- Device-tree model `MF68E 4G LTE Mobile WiFi Router` (the flashed DT's model,
  not independent confirmation of the retail identity).
- Squashfs root with writable ext4 overlay on `/dev/mmcblk0p15` (2.0 GiB).
- Modem and Wi-Fi firmware files present under `/lib/firmware`.
- GC9107 framebuffer driver `fb_gc9107` registered; the user reports the screen
  shows OpenWrt.
- ModemManager enumerates a modem. Cellular registration/data is untested.
- `iw dev` listed no wireless interfaces at the time of the initial check;
  Wi-Fi operation remains unresolved.

The web interface responds at `http://192.168.1.1`; SSH is available as
`root@192.168.1.1`. At first boot, root SSH accepted a connection without a
password. Set a root password through LuCI or `passwd` before regular use.
Physical EDL recovery and a full backup restoration have not been tested.

## IMEI feature development

The modem's `DIAG`, `DIAG_CMD` and `DIAG_CNTL` SMD/RPMsg channels are advertised
on the modem edge. A read-only diagnostic probe successfully read NV item 550.
The new native `modem-identity` CLI decoded the same IMEI reported by ModemManager;
the user also confirmed that this value matches the physical label.

The CLI and LuCI/RPC feature are implemented in `packages/modem-identity/` and
`packages/luci-app-modem-identity/`. A staged ARM64 feature bundle is available
under `installer-output/`. The feature is now installed into the running firmware.
The registered `modem-identity` RPC status method works, the served LuCI JavaScript
matches the source, and its diagnostic IMEI matches ModemManager. Replaced files
were backed up under `/root/modem-identity-before-install-1792278915-8390`.
Sixteen backend/service tests and the LuCI behavior checks pass on the host.
The installed Modem identity page now uses a mobile-first layout. Browser checks
with the router's actual LuCI theme pass at 320, 375, 390, 768 and 1280 px,
including overflow, touch targets, validation and the mocked restart/change flow.
Both served UI assets match source. UI deployment did not change the IMEI or
modem storage mode.

The running daemon remains `rmtfs -P -r -s` (read-only backing storage).
No IMEI write, restore, persistence-mode change or modem restart was performed
for this feature. Actual write acceptance and persistence remain unverified.

Installation records:

- `installer-output/mf68e-5664c9ea/flash-journal.json`
- `installer-output/mf68e-5664c9ea/flash.log`
- `installer-output/mf68e-5664c9ea/installation-result.json`
- `backups/5664c9ea/preflash/postflash-radio/verification.json`

## IMEI persistence investigation — initial failed tests (2026-11-15)

The user-requested replacement passed immediate NV item 550 readback but reverted
to the original identity after a full modem restart. Writable rmtfs was confirmed
with read/write file descriptors on modemst1, modemst2, fsg and fsc. Serialized
graceful shutdown, a 15-second settling period, native QMI offline/reset, and
offline-before-write did not establish persistence. The EFS journal API and
direct DIAG reset were rejected; no unlock or raw partition writes were attempted.

At the end of those initial tests, the device was on its original IMEI with
read-only rmtfs. Before-test radio
partitions, original NV items, and per-attempt results are retained privately in
`backups/5664c9ea/before-imei-persistence-fix/`. The rmtfs shutdown recovery race
and overlapping daemon restart were corrected independently; this does not fix
the modem firmware's unverified persistent identity path.

## Persistent IMEI write resolved (2026-11-15)

The earlier unsupported-persistence conclusion was premature. A traced writable
rmtfs eventually performed successful backing-store writes; a write occurring
about 90 seconds after the requested NV change was followed by successful
`fdatasync`. Waiting for that write before restarting preserved the requested
identity. The IMEI subsequently survived both a full modem restart and a full
router reboot, with read-only rmtfs and no startup reapply service.

The production fix adds an atomic storage acknowledgement record (daemon PID,
sequence, durable byte count, read-only flag and error), the existing QMI force-sync
indication, a guarded pending-commit record in RPC, and UI progress polling before
restart. A timeout keeps the live value in writable mode and offers a continuation
without another NV write. Storage tests cover shadow writes and failed fsync;
isolated real-RPC tests verify early-restart blocking and duplicate-write refusal.

The EFS HELLO rejection did not prove the complete EFS API unavailable: a direct
sync request answered with error 306. No raw radio partition patches, security
unlocks, firmware replacement, or startup IMEI reapplication were required.
