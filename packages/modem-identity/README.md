# Modem identity management

This package adds a root-only CLI and RPC backend for the MSM8916 modem's IMEI.
`luci-app-modem-identity` adds **Network → Modem identity**. The MF68E diffconfig
selects both packages.

The page uses a mobile-first card layout with 44–52 px touch targets, 16 px
input text, live IMEI validation, accessible status feedback and a collapsed
restore section. Desktop screens show editing and storage controls side by side.
The CSS is scoped to this view and does not replace the LuCI theme. Enter or generate an IMEI, then choose **Apply & restart**. The page checks the
current identity, prepares writable storage, saves a backup, sends one change,
returns storage to read-only, and verifies the IMEI after the modem restarts.
Modem readiness is polled automatically with a 90-second deadline; storage
commit has a separate five-minute deadline; request failures
and timeouts release the controls instead of leaving a permanent restart state.
**Restore & restart** follows the same sequence. **Finish & restart** appears
only when editing was left enabled or a storage restart needs recovery.

The implementation uses the modem's advertised `DIAG` RPMsg channel and Qualcomm
NV item **550**. It does not edit raw modem partitions, spoof ModemManager's
display, attempt SPC/security unlocks, or write other NV items.

## Validation status

On device `5664c9ea`, the native ARM64 executable successfully read NV item 550;
its decoded IMEI exactly matched ModemManager. The RPC script's status call was
also exercised on the router using staged files under `/tmp`.

**Persistence is now verified on this unit.** Earlier attempts restarted the
modem after immediate NV readback, before its delayed backing-store write. Live
rmtfs tracing then observed a later write to modemst1 and successful `fdatasync`;
the requested IMEI survived both a full modem restart and a complete router reboot,
with rmtfs returned to read-only mode and no startup reapply service.

The corrected flow records the storage daemon's PID and acknowledged-write sequence
after NV readback, requests its force-sync indication, and waits for a subsequent
successful backing-store acknowledgement before restarting. The observed save
took about 90 seconds after the NV write. The UI allows up to five minutes with a
countdown. The backend also blocks an early restart or a second write while the
save is pending. Timeout leaves the writable daemon alive; **Finish saving &
restart** resumes waiting without repeating the NV write.

The EFS HELLO request was rejected, but this did **not** mean every EFS command
was unsupported: a direct journal-sync request returned error 306. The working
path was established by observing actual storage acknowledgements and verifying
after reboot. No unlock or raw partition patch was needed.

Sixteen backend/service tests exercise a simulated DIAG endpoint: codec and
Luhn validation, escaped/fragmented HDLC packets, asynchronous messages, CRC
checks, backups before writes, preservation of the other NV bytes, refusal in
read-only mode, stale current-IMEI checks, firmware rejection, write timeout
without retries, readback mismatch, restore round trips and backup corruption.
The LuCI view has separate behavioral tests.

## How writes work

1. The tool discovers the RPMsg controller advertising the modem's `DIAG` channel.
   Controller numbers are not hardcoded. It refuses ambiguous targets.
2. It creates a temporary character endpoint and sends an HDLC-framed NV read.
3. For changes, `--expect` must match the live IMEI, and the new IMEI must contain
   15 ASCII digits with a valid Luhn check digit. Identical values do not write.
4. It requires a running, writable `rmtfs` process.
5. Before writing, it saves the complete original 128-byte NV item in a private
   144-byte backup file, checksummed with CRC-16. File and directory are fsynced.
6. It updates only the nine IMEI-encoding bytes, preserving the other NV bytes,
   sends one write, checks the modem's status, then rereads and compares all 128
   bytes. A timeout is reported as an unknown outcome, never retried automatically.
7. It closes and destroys the temporary endpoint. A host lock prevents concurrent
   operations by this tool.

Success means the immediate NV readback matches. It is **not** a claim that the
change persisted across a modem restart. Restart and reread to establish that.

Backups are stored under `/etc/modem-identity-backups/` with directory mode 0700
and file mode 0600. Copy important backups to the host; a factory reset removes
overlay data. Backups contain identifying information and should stay private.

## Persistent storage mode

The existing firmware launches `rmtfs -P -r -s`. Upstream `-r` means **read-only
storage**: changes remain in the daemon's shadow buffers. The previous init
script incorrectly described it as a write-failure fallback.

The updated service reads `/etc/config/rmtfs`:

```uci
config rmtfs 'main'
    option read_only '1'
```

The default stays read-only. **Apply & restart** temporarily enables writable
storage and restarts rmtfs, then restores read-only storage and verifies the
identity after another restart. This briefly interrupts cellular service. The
restart RPC returns immediately, with status reporting `mode_changing` until
the service restart completes. procd sends a single SIGTERM and allows up to
30 seconds for rmtfs to finish its modem/filesystem shutdown handshake.
Failures attempt to restore read-only mode; no IMEI write is retried automatically.

The CLI equivalents are:

```sh
uci set rmtfs.main=rmtfs
uci set rmtfs.main.read_only='0'
uci commit rmtfs
/etc/init.d/rmtfs restart
# Wait for the modem to finish restarting before the next operation.
```

## CLI

```sh
modem-identity read
modem-identity validate NEW_15_DIGIT_IMEI
modem-identity set NEW_15_DIGIT_IMEI --expect CURRENT_15_DIGIT_IMEI
modem-identity restore /etc/modem-identity-backups/item550-TIME-PID.nv \
    --expect CURRENT_15_DIGIT_IMEI
```

Replace the uppercase placeholders with actual values. No example command here
contains a replacement IMEI ready to apply to the device.

`set` and `restore` report the backup path and immediate readback result as JSON.
They do not reboot or reset the modem. Check the current IMEI after an ambiguous
failure before choosing how to recover. A restore also backs up the current item
before writing, and requires writable rmtfs and a matching `--expect` value.

## Build and install

In the OpenWrt builder, apply the repository's package integration and run:

```sh
make package/rmtfs/compile V=s
make package/modem-identity/compile V=s
make package/luci-app-modem-identity/compile V=s
```

The feature needs the **updated rmtfs init/config files**, not just the new binary.
RPMsg CHAR/CTRL and QCOM SMD support are already enabled in this target's kernel.
It has no diagnostic-router or Python dependency on the router.

A staged ARM64 root-filesystem bundle is generated locally under
`installer-output/modem-identity-root/`. Its executable is statically linked and
has been tested on this router. Extract the feature archive to a temporary
directory on the router, then run `sh ./install-staged.sh` from that directory.
The installer checks the board and performs a read-only diagnostic check first,
backs up replaced files, preserves existing rmtfs configuration, and reloads RPC.
It does not change the IMEI or restart the modem. Sign back into LuCI if needed.

## Tests

```sh
CC=cc python3 -m unittest discover -s packages/modem-identity/tests -v
node packages/modem-identity/tests/test_view.js
```

Optional browser checks require Playwright with Chromium:

```sh
node packages/modem-identity/tests/test_mobile.js
```

These checks use mocked modem responses at 320, 375, 390, 768 and 1280 px,
check overflow and touch targets, exercise the editing/restart flow, and save
mobile/desktop previews under `installer-output/previews/`. `LUCI_THEME_CSS`
may point to a downloaded LuCI theme stylesheet for compatibility checks.

Use a native host C compiler in `CC`. Test builds use a Unix socket emulator;
production builds do not contain the test transport or environment overrides.

## Protocol references

- [Qualcomm NV item 550](https://github.com/openpst/libopenpst/blob/master/include/qualcomm/dm_nv.h).
- [NV read/write and IMEI encoding](https://github.com/bkerler/edl/blob/master/edlclient/Tools/qc_diag.py).
- [Linux RPMsg userspace interface](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/rpmsg.h).
- [Qualcomm SMD endpoint selection](https://github.com/torvalds/linux/blob/v6.12/drivers/rpmsg/qcom_smd.c).
- [rmtfs read-only mode](https://github.com/linux-msm/rmtfs/blob/586372e575f5cc1a7cbb170219ab6df98f394cae/rmtfs.c).

The rmtfs package also prevents its ENETRESET recovery loop from restarting the
modem during a requested shutdown, and serializes daemon stop/start. These
restart corrections are used together with acknowledged backing-store writes;
immediate NV readback alone still does not establish persistence.
