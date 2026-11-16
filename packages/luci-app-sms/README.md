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

The messaging interface groups messages by sender, sorts conversations by their
latest message, and opens them as incoming/outgoing bubbles. The conversation
list shows the sender, date, and count; message text stays in the selected
conversation. Search is in the page header. Mobile navigation switches between
the list and a conversation. Drafts are retained independently when switching
conversations, refreshing, or encountering a send failure. The one-line composer
grows as text wraps, with an accessible Send icon inside the field. There are
no decorative taglines or footer notes.

The Google Translate icon in the conversation header opens all text from that
conversation at `translate.google.com`, targeting English. It needs no API key
and runs only after a click. Long conversations open a numbered list of parts;
all Unicode text is retained, with bounded URL lengths. Translation appears in
Google Translate, not inside message bubbles. Drafts are never included.

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
untested at the user's request. The GJS tests use a minimal DOM mock. Browser checks additionally cover mobile
and desktop layouts, enabled conversation rows, safe text, draft retention,
composer growth, and the Google Translate links without contacting Google.

The `summary` read method returns received and unread counts for the Overview
page. Opening a message with `read` marks its content fingerprint as read in
`/tmp/mifi-sms-read`; opening the local SMS inbox reads and marks its displayed
messages. Remote `sms.read` calls also mark a message. Summary counting never
marks messages read. Tracking resets on reboot, does not modify modem storage,
and does not write message text to disk. An unavailable modem yields an unknown
count rather than zero unread. Summary work is bounded to keep Overview responsive.
