![OpenWrt logo](https://raw.githubusercontent.com/openwrt/openwrt/refs/heads/main/include/logo.png)

Modern OpenWrt build targeting MSM8916 devices with full modem, USB gadget, and WiFi support.

## Table of Contents

- [About OpenWrt](#about-openwrt)
- [Supported Devices](#supported-devices)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Building](#building)
- [Installation](#installation)
  - [Install the latest MF68E build](#install-the-latest-mf68e-build)
  - [Flashing from OEM Firmware](#flashing-from-oem-firmware)
  - [Accessing Boot Modes](#accessing-boot-modes)
- [Troubleshooting](#troubleshooting)
  - [No Network / Modem Stuck at Searching](#no-network--modem-stuck-at-searching)
- [Roadmap](#roadmap)
- [Credits](#credits)

---

## About OpenWrt

OpenWrt Project is a Linux operating system targeting embedded devices. Instead of trying to create a single, static firmware, OpenWrt provides a fully writable filesystem with package management. This frees you from the application selection and configuration provided by the vendor and allows you to customize the device through the use of packages to suit any application.

## Supported Devices

All devices use the Qualcomm MSM8916 SoC with 384 MB RAM and 4 GB eMMC.

- **UZ801v3** (`yiming-uz801v3`) -- USB dongle form factor.
- **UF02** (`generic-uf02`) -- USB dongle form factor, most likely with only asian bands. Can be somewhat changed via QPST and the `qcn` file from UZ801.

- **MF68E** (`generic-mf68e`) -- MiFi with GC9107 display and battery monitoring; restored from the archived device support. Hardware validation is still required.

M9S device support remains archived in [TBR](TBR/readme.md).

MF68E builds use `diffconfig_mf68e` and produce boot, system and sysupgrade images.
They omit the shared GPT, firmware ZIP and EDL flash script because those contain
UZ801-specific bootloader settings and a fixed partition layout. These images
expect the existing OpenWrt partition layout (rootfs at partition 14 and
rootfs_data at partition 15); they are not an OEM installation bundle.

A device-specific **experimental** factory installer is now available in
[`installer/mf68e/`](installer/mf68e/README.md) for the backed-up unit with ADB
serial `5664c9ea`. It builds MF68E-selected lk1st firmware and generates a migration
from that unit's stock GPT. It has been flashed with all writes verified and
OpenWrt 25.12.6 boot confirmed over SSH/HTTP. Full peripheral functionality and
physical EDL recovery remain untested. Do not use the shared
UZ801 EDL flasher for this unit. Hardware findings are recorded in
[`device-info.md`](device-info.md).

## Features

### SMS messages

MF68E builds include **Network → SMS**, with incoming and sent messages, a
15-second automatic refresh, and a compose form. Sending requires LuCI write
permission. Failed sends retain the draft and are never retried automatically;
check the message state before sending again after a timeout. Long messages may
use multiple SMS and incur carrier charges. Messages remain managed by the
modem, without an additional persistent archive.

The page and RPC service were checked on the MF68E with ModemManager 1.24.0.
Automated UI tests and isolated backend tests cover reading, sending, Unicode,
input validation and errors. Real carrier sending and receipt of a new incoming
message have not been tested. See [SMS package notes](packages/luci-app-sms/README.md).

### Modem identity management

The MF68E build now includes a native `modem-identity` CLI and
**Network → Modem identity** LuCI page. They support IMEI validation, original-NV
backups, requested NV item 550 changes, readback verification and restore.
Persistent changes require explicitly enabling writable modem storage.
The **Generate IMEI** button fills the input with a random serial and valid Luhn
check digit while preserving the current device's eight-digit type allocation
code. Generation does not change the modem; use **Apply & restart** to save and verify it.
On this unit, the requested IMEI survived a modem restart and full router reboot.
The save flow waits for an acknowledged backing-store write before restarting;
this can take several minutes. See [feature instructions](packages/modem-identity/README.md).

### Mobile navigation

MF68E builds select the [MiFi LuCI theme](packages/luci-theme-mifi/README.md), with
a mobile drawer, desktop sidebar and active-page navigation. It omits the theme
footer and OpenWrt logo branding while retaining LuCI's form components.

### Device button and display

- Single press: wake the status display.
- Double press within half a second: show a full-screen Wi-Fi connection QR code
  for 60 seconds. Single press returns to status.
- Hold for at least three seconds, then release: shut down the router.

Power-on from shutdown is controlled by the PMIC/bootloader and remains
unverified on this unit. The status display shows all IMEI digits in two enlarged
rows and omits the traffic-interface footer.

### Working Components
- **Modem**: Fully functional with cellular connectivity
  - ModemManager Rx/Tx stats not displayed in LuCI (known issue)
- **WiFi**: Complete wireless support
- **USB Gadget Modes**: NCM, RNDIS, Mass Storage, ACM Shell
  - Configure via [UCI](packages/uci-usb-gadget/readme.md) or LuCI app
- **VPN Ready**: TUN driver and WireGuard pre-installed
- **LED Control**: Managed via `hotplug.d` scripts (sysfs-based, no extra packages)

### Storage & Recovery
- **SquashFS Root**: Compressed root filesystem
- **OverlayFS**: ext4 overlay partition for user data (formatted automatically via preinit)
- **Factory Reset**: `firstboot` mechanism enabled

### Additional Packages
- **Tailscale**: LuCI app available as standalone package (APK and IPK)

## Prerequisites

- Docker installed on your system
- Basic knowledge of Linux command line
- For flashing: [edl tool](https://github.com/bkerler/edl)

## Building

### GitHub Actions (release builds)

GHA workflows automatically resolve the **latest OpenWrt 25.12.x** tag. Trigger manually from the Actions tab:

- **Build firmware**: `build.yml` — select a device (`uz801`, `uf02`, or `all`)
- **Build packages**: `build-package.yml` — builds `luci-app-tailscale`, `uci-usb-gadget`, and `luci-app-usb-gadget` in APK and IPK formats

### Local (snapshot builds)

1. Build the environment (defaults to OpenWrt `main`/snapshot):
```
cd devenv
docker compose build builder
```

2. Enter and build:
```
docker compose run --rm builder
cp /repo/diffconfig_uz801 .config
make defconfig
make -j$(nproc)
```

To build a specific release locally:
```
OPENWRT_VERSION=v25.12.6 docker compose build builder
```

For MF68E, run `bash /repo/devenv/build-mf68e.sh` inside the builder instead
of the UZ801 commands above. This checks the device and display package selections,
downloads sources, and builds with eight jobs (`BUILD_JOBS` overrides this).
Output is saved to `bin/targets/msm89xx/msm8916/` on the host.

> **Supported versions:** OpenWrt 25.12.x and current snapshots (kernel 6.12). OpenWrt 24.10.x (kernel 6.6) compiles but does not boot — the Makefile supports it via `KERNEL_FOR_24` (currently commented out) if someone wants to investigate further.

## Installation

### Install the latest MF68E build

These steps update **the backed-up device with serial `5664c9ea`, already running
OpenWrt with board name `generic,mf68e`**. Its initial factory migration is complete.
Use the MF68E image only. The commands below run on the host from the repository
root unless noted otherwise; connect the router by USB and keep power connected
throughout the upgrade.

#### 1. Build or locate the image

To build the current checkout against the validated OpenWrt 25.12.6 release:

```bash
cd devenv
OPENWRT_VERSION=v25.12.6 docker compose build builder
docker compose run --rm builder bash /repo/devenv/build-mf68e.sh
cd ..
```

If the latest local build is already present, skip the build commands. Outputs
are in `bin/targets/msm89xx/msm8916/`. Use
`openwrt-msm89xx-msm8916-generic-mf68e-squashfs-sysupgrade.bin` for this update;
`boot.img` and `system.img` are separate factory-installer payloads.
The existing artifacts report revision `r33311-981c978eff`; rebuilding may change
their checksums. GitHub Actions' firmware workflow currently selects UZ801/UF02,
so use the local MF68E build procedure above for this device.

Verify the build outputs before transferring them:

```bash
(cd bin/targets/msm89xx/msm8916 && sha256sum -c sha256sums)
```

Every listed file should report `OK`. Keep the image and `sha256sums` from the
same build together.

#### 2. Check the router and save its configuration

The router is available at `192.168.1.1` over USB. Check its board identity:

```bash
ssh root@192.168.1.1 'cat /tmp/sysinfo/board_name; ubus call system board'
```

The board name must be `generic,mf68e`. Stop if it differs. Save a configuration
archive to the host before updating:

```bash
ssh root@192.168.1.1 'sysupgrade -b /tmp/mf68e-config-backup.tar.gz'
scp -O root@192.168.1.1:/tmp/mf68e-config-backup.tar.gz ./mf68e-config-backup.tar.gz
```

Keep this archive private. It contains configuration and credentials; it does
not replace the full stock eMMC and radio backups described in
[device-info.md](device-info.md).

#### 3. Transfer, validate and install

```bash
scp -O bin/targets/msm89xx/msm8916/openwrt-msm89xx-msm8916-generic-mf68e-squashfs-sysupgrade.bin root@192.168.1.1:/tmp/mf68e-sysupgrade.bin
sha256sum bin/targets/msm89xx/msm8916/openwrt-msm89xx-msm8916-generic-mf68e-squashfs-sysupgrade.bin
ssh root@192.168.1.1 'sha256sum /tmp/mf68e-sysupgrade.bin'
ssh root@192.168.1.1 'sysupgrade -T /tmp/mf68e-sysupgrade.bin'
```

Compare the two SHA-256 values; they must match. Continue only if the image test
succeeds. Do not use `-F` to bypass a rejected image.

```bash
ssh root@192.168.1.1 'sysupgrade /tmp/mf68e-sysupgrade.bin'
```

The SSH connection will close while the router writes the image and reboots.
Leave power connected and allow several minutes for it to return. The default
command requests configuration preservation. The project's upgrade hook clears
the overlay, so manually installed packages and other files outside the saved
configuration must be reinstalled or backed up separately. Configuration restore
across an upgrade has not yet been verified on this unit.

For a clean installation, use `sysupgrade -n /tmp/mf68e-sysupgrade.bin` instead;
this discards configuration, including passwords and network settings.

After the router returns, reconnect USB if needed to renew the host's DHCP lease,
open http://192.168.1.1, and verify the running version:

```bash
ssh root@192.168.1.1 'ubus call system board; df -h /overlay'
```

If you preserved a different LAN address, reconnect at that address. After a clean
installation, set a root password through LuCI or `passwd`. Check the display,
Wi-Fi and cellular connection separately: initial OpenWrt boot is confirmed, but
Wi-Fi and cellular data operation remain unverified on this unit. This sysupgrade
procedure is based on the project's upgrade implementation; a completed hardware
sysupgrade has not yet been recorded.

#### Installing from stock Android

A stock Android device needs the device-specific GPT/bootloader migration before
it can use sysupgrade. Follow the full
[experimental MF68E factory installer instructions](installer/mf68e/README.md),
including backup verification, firmware preparation, explicit EDL flashing and
first boot. That installer is pinned to this unit's stock preflash snapshot;
do not rerun it on the already migrated device or reuse it for another unit.
Do not write OpenWrt images directly to stock partitions 14/15 or use the shared
UZ801 flasher on this device.

### Flashing from OEM Firmware

The shared flashing steps below apply to UZ801/UF02. For MF68E, use the
[device-specific instructions above](#install-the-latest-mf68e-build).

1. **Install EDL tool**: https://github.com/bkerler/edl
2. **Enter EDL mode**:
   - **UZ801v3**: See [PostmarketOS wiki guide](https://wiki.postmarketos.org/wiki/Zhihe_series_LTE_dongles_(generic-zhihe)#How_to_enter_flash_mode)

3. **Backup original firmware**:
   ```
   edl rf backup.bin
   ```

4. **Flash OpenWrt**:
   ```
   ./openwrt-msm89xx-msm8916-*-flash.sh
   ```

   > The script flashes entirely via EDL (no fastboot step). It automatically backs up radio partitions, writes the new GPT, firmware, boot and rootfs, and restores the backed-up partitions.

### Accessing Boot Modes

#### UZ801v3
- **Fastboot mode**: Insert device while holding the button
- **EDL mode**: Boot to fastboot first, then execute: `fastboot oem reboot-edl`

#### UF02
- **Fastboot mode**:
  - From OEM: `adb reboot bootloader`.
  - From OpenWrt: Enter `edl` and erase boot partition (`edl e boot`).
- **EDL mode**:
  - From OEM: `adb reboot bootloader`, flash `lk2nd` aboot. Reboot pressing the button.
  - From OpenWrt: Insert device while holding the button.

## Troubleshooting

### No Network / Modem Stuck at Searching

The modem requires region-specific MCFG configuration files.

#### Extract MCFG from Your Firmware

1. **Dump modem partition**:
   ```
   edl r modem modem.bin
   ```

2. **Mount and navigate**:
   ```
   # Mount modem.bin (it's a standard Linux image)
   cd image/modem_pr/mcfg/configs/mcfg_sw/generic/
   ```

3. **Select your region**:
   - `APAC` - Asia Pacific
   - `CHINA` - China
   - `COMMON` - Generic/fallback
   - `EU` - Europe
   - `NA` - North America
   - `SA` - South America
   - `SEA` - South East Asia

4. **Locate your carrier's MCFG**: Navigate to your telco's folder and find `mcfg_sw.mbn`. If your carrier isn't listed, use a generic configuration from the `common` folder.

#### Apply the Configuration

**Transfer to device** (capitalization matters!):
   ```
   scp -O mcfg_sw.mbn root@192.168.1.1:/lib/firmware/MCFG_SW.MBN
   # ... and reboot the device ...
   ```

## Roadmap

- [ ] Custom package server for msm89xx/msm8916
  - Note: Target-specific modules may require building from source via `make menuconfig`
  - The target-specific APK feed is automatically removed on first boot (msm89xx is not on downloads.openwrt.org)
- [ ] Investigate `lpac` for eSIM support
- [x] Memory expansion: `kmod-zram` + `zram-swap` enabled on all devices

## Credits

- **[@ghosthgy](https://github.com/ghosthgy/openwrt-msm8916)** - Initial project foundation
- **[@lkiuyu](https://github.com/lkiuyu/immortalwrt)** - MSM8916 support, patches, and OpenStick feeds
- **[@Mio-sha512](https://github.com/Mio-sha512/OpenStick-Builder)** - USB gadget and firmware loader concepts
- **[@AlienWolfX](https://github.com/AlienWolfX/UZ801-USB_MODEM/wiki/Troubleshooting)** - Carrier policy troubleshooting guide
- **[@gw826943555](https://github.com/gw826943555/luci-app-tailscale) & [@asvow](https://github.com/asvow)** - Tailscale LuCI application
