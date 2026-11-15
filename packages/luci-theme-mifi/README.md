# MiFi LuCI theme

A mobile-first navigation shell built on LuCI's native JavaScript and the
Bootstrap theme's existing form styles. It replaces the navigation and theme
templates without changing router functions or modifying upstream Bootstrap files.

- Desktop: fixed sidebar with expandable groups and an active-page highlight.
- Below 900 px: a Menu button opens a touch-friendly navigation drawer.
- Escape or the backdrop closes the drawer and returns focus to the Menu button.
- Hidden navigation cannot receive keyboard focus; page content is inert while
  the mobile drawer is open.
- Shared forms and custom modem views use square corners and one-pixel section
  separators, with no card shadows.
- Navigation and form tabs share a flat baseline with an active underline, visible
  keyboard focus, and horizontal scrolling on narrow screens.
- Existing LuCI subpage tabs, indicators, login, sign-out and system notices remain.
- The distribution footer, OpenWrt header branding and logo favicons are omitted.
  The header uses the text “MiFi”.

The theme is active on the device. Live authenticated browser checks passed at
320, 390, 768 and 1280 px with no horizontal overflow or JavaScript errors.
Templates were compiled with the device's ucode compiler before activation.
IMEI and modem configuration were not changed by the theme deployment.

The MF68E diffconfig selects `luci-theme-mifi`. Package installation registers
the theme and selects `/luci-static/mifi` through its UCI defaults script.

## Revert to Bootstrap

```sh
uci set luci.main.mediaurlbase='/luci-static/bootstrap'
uci commit luci
```

Reload the browser. The upstream Bootstrap templates and assets are preserved.
The original LuCI configuration was also backed up on the router under
`/root/luci-before-mifi-theme-*` before the theme was activated.

## Tests

The browser test requires Playwright and its Chromium browser:

```sh
node packages/luci-theme-mifi/tests/test_menu.js
```

It uses a mock permission-filtered LuCI menu tree and does not connect to the
router. It verifies active navigation, subpage tabs, mobile drawer behavior,
Escape/focus handling, backdrop closing, and desktop/mobile resizing.

The flat CSS update was checked in Chromium at 320, 390, 768 and 1280 px
against the router’s Bootstrap stylesheet with representative form and modem
markup. Tab height, active underline, square corners and page overflow were
checked; the navigation browser checks also passed.

Interfaces and Wireless use `network.css` for responsive status rows and action
buttons. Labels remain on one line; actions use a two-column grid on phones
and wide desktops. Authenticated Chromium checks on both live pages passed at
320, 390, 768 and 1280 px, including the Wireless Edit dialog. These checks did
not apply settings or restart interfaces.
