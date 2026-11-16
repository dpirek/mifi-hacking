# OpenVPN on the MF68E

The management pages are the upstream `luci-app-openvpn` package, selected in
`diffconfig_mf68e`. They appear at **VPN → OpenVPN**, including instance controls,
OVPN profile upload, file editing, and basic/advanced settings. LuCI source is in
the OpenWrt feed at `applications/luci-app-openvpn`.

The current custom kernel has `kmod-tun` but no matching
`kmod-ovpn-backports`. The official 25.12.6 OpenVPN 2.7.8 package requires that
optional acceleration module. Normal firmware builds therefore explicitly turn
off `CONFIG_OPENVPN_openssl_ENABLE_DCO` and compile OpenVPN for userspace TUN.
No kernel replacement is required.

## Installation on the existing router

`repackage.py` reproduces the package deployed to the current router. It uses
the official `aarch64_generic` `openvpn-openssl-2.7.8-r1.apk` payload downloaded
from the signed OpenWrt 25.12.6 package repository. The input SHA-256 is pinned
in the script. It preserves the binary, configuration, and package lifecycle
scripts; changes the init command to explicitly pass `--disable-dco`; removes
only the `kmod-ovpn-backports` dependency; and creates version `2.7.8-r2` with a
local signature. All other runtime dependencies remain required. File owners
are recorded as root even when packaging as a normal workstation user.

Use apk-tools 3 with `extract`, `adbdump`, and `mkpkg` support. The router's
minimal apk build lacks `mkpkg`; an aarch64 static apk-tools binary can run on
the ARM64 workstation. Generate a private signing key outside tracked source,
and retain its corresponding public key in the router's `/etc/apk/keys/`.

```sh
python3 packages/openvpn-userspace/repackage.py \
  --apk /absolute/path/to/apk.static \
  --source /absolute/path/to/openvpn-openssl-2.7.8-r1.apk \
  --sign-key /absolute/path/to/private-signing-key.pem \
  --output /absolute/path/to/openvpn-openssl-2.7.8-r2.apk
```

Install `luci-app-openvpn` and the declared runtime dependencies from the
matching official release, then install the locally signed APK. No dependency
checks or kernel version checks are overridden. The local signing key and all
downloaded/generated packages are kept under ignored `installer-output/`.

## Validation and limitations

On the live router, OpenVPN reports version 2.7.8 with OpenSSL 3.5.9. TUN
creation/removal was verified with a temporary interface. Browser checks cover
the menu, instance list, basic/advanced editors, disabled test-profile import,
file editor, and mobile/desktop layout. Test profiles are removed afterwards.

The shipped example instances are disabled. Installation does not configure a
provider, certificates, firewall forwarding, DNS, a kill switch, or a default
route. A real VPN connection still needs a valid profile and a separate
end-to-end connectivity test. The local package deliberately uses userspace
TUN rather than DCO; do not replace it with a repository build requiring an
unavailable kernel module.
