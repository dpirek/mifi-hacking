# MiFi remote manager

A standalone **Node.js 22+ and vanilla JavaScript** application. It uses only
Node's standard library: no npm packages, install step, bundler or database server.
The accompanying OpenWrt packages add an outbound management agent and
**System → Remote management** in LuCI.

## Run locally

```sh
cd remote-manager
MANAGEMENT_PASSWORD='use-a-long-unique-password' \
PUBLIC_ORIGIN='http://localhost:3000' node server.js
```

Open `http://localhost:3000`. `PUBLIC_ORIGIN` must match the browser's exact origin.
The default bind address is `127.0.0.1` and port is `3000`. Persistent router records
are saved under `.data/` (override with `DATA_DIR`). Router tokens are stored only
as SHA-256 hashes. Sessions and queued requests are in memory; restarting the
server requires signing in again. A server restart never replays queued changes.

## Test from a router over your LAN

HTTP and localhost origins are supported without a special agent flag. To run
on your computer and connect from the router:

```sh
HOST=0.0.0.0 PORT=3000 PUBLIC_ORIGIN=http://192.168.1.183:3000 \
MANAGEMENT_PASSWORD='use-a-long-unique-password' node server.js
```

Replace `192.168.1.183` with your computer's LAN address. Open that same URL in
your browser and enter it in the router's Remote management settings. Allow the
port through your computer's firewall if necessary. The `PUBLIC_ORIGIN` must
match the URL you use in the browser, including scheme and port.

`http://localhost:3000` and `http://127.0.0.1:3000` refer to the machine making
the connection. On the router, those addresses point to the router, not your
computer. HTTP sends the management session and router token without encryption;
use it on your local test network and use HTTPS on a public server.

## Host at https://mifi.bohoosh.com

1. Point the domain at your server and provide a valid HTTPS certificate through
   your existing reverse proxy. This repository does not change DNS or publish a
   server automatically.
2. Copy `server.js` and `public/` to `/opt/mifi-manager/`. Install Node.js 22+ on
   that server. No `npm install` is needed.
3. Copy `.env.example` to `/etc/mifi-manager.env`, set a long unique management
   password, and set `PUBLIC_ORIGIN=https://mifi.bohoosh.com`. Keep this file
   readable only by root (`chmod 600`). `DATA_DIR=/var/lib/mifi-manager` works with
   the supplied systemd unit.
4. Install `deploy/mifi-manager.service` in `/etc/systemd/system/`, then run
   `systemctl daemon-reload` and `systemctl enable --now mifi-manager`.
5. Add `deploy/nginx.conf` inside the domain's existing TLS-enabled server block,
   validate the proxy configuration, and reload it. Keep Node bound to localhost.
   Allow at least 75 seconds for proxy responses because requests use long polling.

Use a dedicated origin for this app. Use HTTPS for production; the router
verifies the server certificate. Configure the canonical HTTPS origin directly;
the `/api/agent/` endpoints must not redirect to another host.
Changing `MANAGEMENT_PASSWORD` and restarting the service invalidates all browser
sessions. Back up `DATA_DIR` to preserve router registrations; replacing it requires
pairing routers again. There is one administrator account; multi-user roles are
not implemented.

## Pair a router

1. Sign in to the management app and choose **Pair a router**.
2. Name it and copy the newly generated token. It is displayed only once.
3. On that router, open **LuCI → System → Remote management**.
4. Enter the HTTP or HTTPS server origin and token, enable remote management, and save.
5. The device appears as connected when its outbound poll reaches the server.

The firmware package is `luci-app-mifi-remote`; `diffconfig_mf68e` selects it.
It depends on `mifi-remote`, uclient-fetch, TLS support, trusted CA certificates and the SMS and Calls packages.
Existing compatible routers can install the files without a firmware reflash;
see `../packages/mifi-remote/install-staged.sh` for staged installation. The feature
is disabled by default. Pairing tokens are stored locally in a root-readable UCI
configuration and are never returned by the LuCI status API.

The workstation installation leaves the feature disabled until you configure an
actual server. `https://mifi.bohoosh.com` is an example default, not a deployed
service or an automatically trusted destination.

## Available management

- Overview: model, firmware, hostname, kernel, uptime and memory.
- Interfaces: connection state, addresses and restart controls.
- Wireless: radios, SSIDs and start/stop controls. These affect runtime state;
  persistent Wi-Fi configuration still uses local LuCI.
- SMS: list and read messages, compose and send text. SMS are not archived by the
  server. Sending requires confirmation; long SMS may incur multiple charges.
- Remove device: select a router and choose **Remove device** beside Refresh, then
  confirm its name. Removal immediately revokes access, including for offline
  devices. Pair the device again to reconnect it.
- Calls: incoming-call status and caller number, dial, answer, reject and hang up.
  Browser audio is unavailable. Actual calling requires carrier voice support;
  no real phone call has been tested. The Calls tab polls every five seconds while
  visible.
- Connection: rotate a router's pairing token.

This is a focused remote dashboard, not a mirror of every LuCI screen. It does
not expose a general shell, an arbitrary ubus method, a raw HTTP proxy, modem
identity writes or firmware flashing. Router connectivity is needed for commands;
Internet/APN setup and recovery remain available locally.

## Relay API

Browser endpoints require the HttpOnly, SameSite=Strict administrator cookie.
Every modifying browser request must have an Origin matching `PUBLIC_ORIGIN`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/login` | `{password}`; establish an 8-hour browser session |
| `POST /api/logout` | End the session |
| `GET /api/routers` | Names, online status and last seen |
| `POST /api/routers` | `{name}`; create a router and return its one-time token |
| `DELETE /api/routers/:id` | Remove and revoke |
| `POST /api/routers/:id/rotate` | Replace its pairing token |
| `POST /api/routers/:id/commands` | `{action,args}`; wait for a router result |

The router authenticates with `Authorization: Bearer <router-token>`:

- `POST /api/agent/poll` with `{}` waits up to 20 seconds for a request.
- `POST /api/agent/result` with `{id,result}` returns a request result.

The server and router both allowlist actions: `status`, `interfaces`, `wireless`,
`sms.list`, `sms.read` (`id`), `sms.send` (`number`, `text`), `interface.restart`
(`name`), `wireless.up` (`name`), `wireless.down` (`name`), `calls.list`,
`calls.dial` (`number`), and `calls.answer`/`calls.reject`/`calls.hangup`
(`id`, `expected` call state). The router dispatches
those to existing local APIs; it never interprets a server-supplied shell command.
No browser can choose a proxy URL, arbitrary file, executable or ubus object.

Only one command can be outstanding per router. Commands expire after 55 seconds;
results are returned to the initiating browser, without being archived. The agent
runs each delivered request once, and the server never redelivers it. A timeout
or a connection lost during a change has an uncertain outcome: refresh status
before repeating a change or sending another SMS. Restarting the active WAN
interface can interrupt result delivery even if the restart succeeded.

Tokens grant the allowed access to one router. Anyone controlling the management
server can perform those actions; disable the router agent or revoke its token
to disconnect it. Full wireless status can include configuration data, so treat
the management server and browser session as trusted administrative access.

## Verify

```sh
node --test test/server.test.js
node --check server.js
node --check public/app.js
```

Tests use simulated agents, including simulated SMS. They cover auth, origin
checks, token hashing/revocation, cross-router result isolation, allowlisting,
command validation, busy/offline handling and timeout behavior without replay.
No real SMS is sent during verification.

Verification on the MF68E also covered an actual outbound agent poll, a queued
read-only system-status request, and its authenticated response to a temporary
server on the USB LAN. The LuCI pairing page was checked at 320, 390 and 1280 px;
the remote app was checked at 320, 390, 768 and 1280 px. Server/browser tests used
simulated SMS only. Public HTTPS hosting, real WAN reconnects and live SMS delivery
were not tested. The production agent remains disabled and unpaired.

To prepare a repeatable on-device installation bundle from this checkout:

```sh
python3 packages/mifi-remote/prepare-bundle.py /tmp/mifi-remote-bundle.tar.gz
scp -O /tmp/mifi-remote-bundle.tar.gz root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'mkdir -p /tmp/mifi-remote-install; tar -xzf /tmp/mifi-remote-bundle.tar.gz -C /tmp/mifi-remote-install; sh /tmp/mifi-remote-install/install-staged.sh'
```

Run these commands from the repository root. The installer verifies checksums,
backs up existing files, preserves any existing pairing, and reloads rpcd. A fresh
installation remains disabled. It requires the router's existing TLS-enabled
`uclient-fetch`, trusted CA bundle, rpcd and SMS package. The optional isolated
OpenWrt dispatcher test is `sh tests/test-dispatch.sh /usr/libexec/mifi-remote-dispatch`
from `packages/mifi-remote/`; it stubs network operations and sends no SMS.

Call-control implementation and test details are in
[`luci-app-calls`](../packages/luci-app-calls/README.md). Restart an existing Node
process after updating this source to load the new Calls tab and API actions.
