// Browser behavior tests with a mock LuCI tree. No device connection or changes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '../htdocs/luci-static');
const source = fs.readFileSync(path.join(base, 'resources/menu-mifi.js'), 'utf8');
const css = fs.readFileSync(path.join(base, 'mifi/cascade.css'), 'utf8').replace(/^@import[^;]+;/gm, '');
(async () => {
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body class="mifi-shell"><header class="mifi-header"><button id="mifi-menu-toggle" class="mifi-menu-toggle" aria-controls="mifi-navigation" aria-expanded="false">Menu</button><a class="mifi-brand">MiFi</a></header><button id="mifi-nav-shade" class="mifi-nav-shade" hidden>Close navigation</button><nav id="mifi-navigation" class="mifi-navigation" hidden><ul id="topmenu" class="mifi-menu"></ul><div id="mifi-mode-menu" hidden></div></nav><main id="maincontent" class="container"><div id="tabmenu" style="display:none"></div><input aria-label="Content field"></main>');
  await page.addStyleTag({ content: css });
  await page.evaluate(source => {
   const tree = { children: { admin: { title: 'Administration', children: {
    status: { title: 'Status', children: { overview: { title: 'Overview' } } },
    network: { title: 'Network', children: {
     interface: { title: 'Interfaces' },
     identity: { title: 'Modem identity', children: { settings: { title: 'Settings' }, backup: { title: 'Backup' } } }
    } }, logout: { title: 'Logout' }
   } } } };
   const ui = { menu: { getChildren: node => Object.entries(node.children || {}).map(([name, child]) => ({ ...child, name })) } };
   const L = { env: { requestpath: ['admin', 'network', 'identity'], dispatchpath: ['admin', 'network', 'identity', 'settings'] }, url: (...parts) => '/' + parts.join('/') };
   function E(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) if (value != null) node.setAttribute(key, value);
    for (const child of Array.isArray(children) ? children : children == null ? [] : [children]) node.append(child);
    return node;
   }
   const module = new Function('baseclass', 'ui', 'E', 'L', '_', source)({ extend: x => x }, ui, E, L, x => x);
   module.render(tree);
  }, source);
  const toggle = page.locator('#mifi-menu-toggle'), nav = page.locator('#mifi-navigation');
  assert(await nav.isHidden());
  assert.equal(await page.locator('.mifi-nav-link[aria-current="page"]').getAttribute('href'), '/admin/network/identity/settings');
  assert.equal(await page.locator('#tabmenu .active a').textContent(), 'Settings');
  assert.equal(await page.locator('a[href="/admin/logout"]').count(), 0);
  await toggle.click();
  assert(await nav.isVisible());
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert(await page.locator('#maincontent').evaluate(e => e.inert));
  await page.keyboard.press('Escape');
  assert(await nav.isHidden());
  assert(await toggle.evaluate(e => document.activeElement === e));
  await toggle.click();
  await page.locator('#mifi-nav-shade').click({ position: { x: 380, y: 100 } });
  assert(await nav.isHidden());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(100);
  assert(await nav.isVisible());
  assert(await toggle.isHidden());
  assert.equal(await page.locator('#maincontent').evaluate(e => e.inert), false);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(100);
  assert(await nav.isHidden());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('Navigation browser checks passed.');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
