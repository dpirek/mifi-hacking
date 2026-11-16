# LuCI Calls

Adds **Network → Calls** at `/cgi-bin/luci/admin/network/calls`, using the
ModemManager Voice and Call interfaces. MF68E builds select `luci-app-calls`.

The page refreshes every three seconds while open. It displays incoming caller
numbers when provided, private/unknown callers, outgoing calls and current call
states. Ringing incoming calls offer **Answer** and **Reject**; other ongoing
calls offer **Hang up**. Dialing and answering require confirmation. Dialing may
incur carrier charges. The page keeps an outgoing number after a failed request.

**This is call control only.** The router currently has no working audio path,
and there is no browser microphone/speaker bridge. Answering or dialing does not
provide browser audio. Actual inbound/outbound calling also depends on the SIM,
carrier, registration and voice/VoLTE configuration. Availability of the voice
interface does not establish end-to-end voice service.

The `calls` rpcd object provides:

| Method | Arguments | Access |
| --- | --- | --- |
| `list` | none | read |
| `dial` | `number` | write |
| `answer` | `id`, `expected` | write |
| `reject` | `id`, `expected` | write |
| `hangup` | `id`, `expected` | write |

`list` returns `{supported, browser_audio, calls, partial}`. Each call has an ID,
number, direction, state and state reason. `browser_audio` is currently false.
Unsupported or unavailable modem responses return an `error`, rather than an
empty list that could imply there are no calls. Caller numbers are rendered as
text, never HTML. Lists are bounded to 16 calls and a short read budget; a partial
list is identified in the UI. No persistent call history is maintained.

Numbers allow 1–20 digits with an optional leading `+`. The backend validates
IDs and rereads the current call state before an action. `expected` must match
that state, and answer/reject additionally require an incoming ringing/waiting
call. Reject uses the modem's hang-up operation for that incoming call. Requests
are never automatically retried; after an error or timeout, refresh the call list
before repeating an action. A dial timeout can occur after the call was started.

The standalone remote manager has a matching **Calls** tab. Its agent dispatches
only `calls.list`, `calls.dial`, `calls.answer`, `calls.reject` and `calls.hangup`
to this same backend. It polls every five seconds while that tab is visible and
preserves the number draft and focus. It does not expose arbitrary modem commands.
Restart a running Node server after updating its source to load the new routes.
The remote-manager installation bundle includes this package's files.

Implementation follows the official [mmcli command reference](https://www.freedesktop.org/software/ModemManager/man/latest/mmcli.1.html).

## Verification

On OpenWrt, run the isolated backend test against a staged or installed service:

```sh
sh test_backend.sh /usr/libexec/rpcd/calls
```

The test prepends a fake `mmcli`; it does not create, answer or terminate real
calls. It covers list parsing, caller data, dial/answer/reject/hang-up, stale state,
input validation, unsupported modems, failures and no automatic retries.

From the repository root, the server test needs only Node.js:

```sh
node --test remote-manager/test/server.test.js
```

Optional browser checks use Playwright supplied by the test environment (it is
not a production dependency):

```sh
node packages/luci-app-calls/tests/test_view.cjs
node packages/luci-app-calls/tests/test_remote.cjs
```

Browser checks cover simulated incoming calls and all controls at 320, 390, 768
and 1280 px, caller-text escaping, read-only controls, unavailable service,
no retries, remote relaying and dial-draft retention during polling. Live checks
on the MF68E verified the installed page and voice-call listing. No real phone
call was placed, answered, rejected or hung up during verification; carrier
calling and two-way audio remain unverified.
