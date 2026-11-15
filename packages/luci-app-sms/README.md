# LuCI SMS

`luci-app-sms` adds **Network → SMS** using the installed ModemManager. It lists
incoming and outgoing messages and sends text messages through `mmcli`. The
MF68E build selects the package automatically. No firmware reflash is needed
when installing its files on an existing compatible OpenWrt system.

The `sms` RPC object exposes `list`, `read(id)` and `send(number, text)`.
Read and send permissions are separate in the LuCI ACL. Recipient validation
allows up to 20 digits and an optional leading `+`. Text is limited to 4096
UTF-8 bytes and passed through a private temporary file, preserving punctuation
and newlines without property-parser interpolation. The file is removed when
the request finishes. No send operation is automatically retried. A timeout can
mean the network accepted the message; inspect its state before sending again.

The page polls every 15 seconds, shows message states and timestamps, and retains
drafts after errors. Sent means accepted by the network, not confirmed delivery.
Messages are managed by the modem and are not archived separately by the page.

Run the UI behavior tests on a host with GJS:

```sh
gjs packages/luci-app-sms/tests/test_view.js
```

On OpenWrt, run the isolated backend tests with the package directory copied to
`/tmp/luci-app-sms-test`:

```sh
sh /tmp/luci-app-sms-test/tests/test_backend.sh /tmp/luci-app-sms-test/root/usr/libexec/rpcd/sms
```

Backend tests use a fake `mmcli`; they do not send SMS or change the real modem.
Live verification confirmed the RPC methods, modem SMS listing and supported
storage on the MF68E. Real carrier sending and receipt of a new message remain
untested at the user's request. The UI tests use a minimal DOM mock, not a browser.
