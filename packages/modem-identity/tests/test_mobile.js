// Optional visual/layout tests. Requires Playwright + its Chromium browser.
// All modem calls are mocked; this test never connects to the router.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const resources = path.resolve(__dirname, '../../luci-app-modem-identity/htdocs/luci-static/resources/view/modem-identity');
const source = fs.readFileSync(path.join(resources, 'config.js'), 'utf8');
const css = fs.readFileSync(path.join(resources, 'config.css'), 'utf8');
const theme = process.env.LUCI_THEME_CSS ? fs.readFileSync(process.env.LUCI_THEME_CSS, 'utf8') : '';
const output = path.resolve(__dirname, '../../../installer-output/previews');

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        for (const width of [320, 375, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#f4f6fa;font-family:system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:16px}</style></head><body><main></main></body></html>');
            if (theme) await page.addStyleTag({ content: theme });
            await page.addStyleTag({ content: css });
            await page.evaluate(source => {
                let state = { imei: '490154203237518', persistent_writes: false };
                window.modemCalls = [];
                const rpc = { declare: spec => (...args) => {
                    window.modemCalls.push({ method: spec.method, args });
                    if (spec.method === 'status') return Promise.resolve({ ...state });
                    if (spec.method === 'write_mode') { state.persistent_writes = args[0]; return Promise.resolve({ ok: true }); }
                    if (spec.method === 'change') { state.imei = args[0]; return Promise.resolve({ changed: true, imei: state.imei, backup: '/etc/modem-identity-backups/item550-test.nv' }); }
                    throw new Error('Unexpected mocked RPC');
                } };
                function E(tag, attrs, children) {
                    const element = document.createElement(tag);
                    for (const [key, value] of Object.entries(attrs || {})) {
                        if (typeof value === 'function') element.addEventListener(key, value);
                        else if (value === true) element.setAttribute(key, '');
                        else if (value !== false && value != null) element.setAttribute(key, value);
                    }
                    for (const child of Array.isArray(children) ? children : children == null ? [] : [children]) element.append(child);
                    return element;
                }
                String.prototype.format = function(value) { return this.replace('%s', value); };
                const definition = new Function('view', 'rpc', 'ui', 'E', '_', 'L', source)(
                    { extend: value => value }, rpc, { addNotification() {} }, E,
                    value => value, { resource: () => 'data:text/css,' });
                document.querySelector('main').append(definition.render({ ...state }));
            }, source);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}px`);
            for (const button of await page.getByRole('button').all()) {
                const box = await button.boundingBox();
                if (box) assert(box.height >= 44, `Small touch target at ${width}px`);
            }
            assert.equal(await page.locator('#mi-new-imei').evaluate(el => getComputedStyle(el).fontSize), '16px');
            assert(await page.locator('[data-action="change"]').isDisabled());
            if (width === 390 || width === 1280) await page.screenshot({
                path: path.join(output, width === 390 ? 'modem-identity-mobile.png' : 'modem-identity-desktop.png'), fullPage: true
            });
            await page.locator('summary').click();
            await page.locator('#mi-backup').fill('item550-1234567890123456789012345678901234567890-456.nv');
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Restore overflow at ${width}px`);
        }
        await page.locator('[data-action="generate"]').click();
        assert.match(await page.locator('#mi-new-imei').inputValue(), /^[0-9]{15}$/);
        assert(await page.locator('[data-action="change"]').isEnabled());
        await page.locator('#mi-new-imei').fill('356938035643800');
        assert.equal(await page.locator('#mi-new-imei').getAttribute('aria-invalid'), 'true');
        await page.locator('#mi-new-imei').fill('356938035643809');
        await page.locator('[data-action="change"]').click();
        await page.getByRole('status').filter({ hasText: 'IMEI saved and verified after restart' }).waitFor();
        assert.equal(await page.locator('#mi-current').textContent(), '356938035643809');
        assert(await page.locator('[data-action="change"]').isDisabled());
        const calls = await page.evaluate(() => window.modemCalls);
        assert.deepEqual(calls.map(call => call.method), ['status', 'write_mode', 'status', 'change', 'write_mode', 'status']);
        assert.deepEqual(calls.filter(call => call.method === 'write_mode').map(call => call.args[0]), [true, false]);
        console.log('Browser checks passed at 320, 375, 390, 768 and 1280 px; automatic apply and restart verification passed.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
