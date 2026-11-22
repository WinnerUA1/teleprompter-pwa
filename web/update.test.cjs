const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(__dirname + '/update.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
async function scenario(installedVersion, offline = false) {
    const elements = {};
    let click, redirected;
    const context = {
        document: { querySelector(id) { return elements[id] ||= { addEventListener(_, handler) { click = handler; } }; } },
        fetch: async () => { if (offline) throw new Error('offline'); return { ok: true, text: async () => '' }; },
        DOMParser: class { parseFromString() { return { querySelector: () => ({ content: '1.1.12' }) }; } },
        navigator: { serviceWorker: {
            register: async () => ({ update: async () => {}, active: { postMessage(_, ports) { ports[0].reply({ data: { version: installedVersion } }); } } }),
            ready: Promise.resolve()
        } },
        MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { reply: event => this.port1.onmessage(event) }; } },
        window: { isSecureContext: true, location: { replace(url) { redirected = url; } } },
        setTimeout, clearTimeout, Date, encodeURIComponent
    };
    vm.runInNewContext(script, context);
    await click();
    return { elements, redirected };
}
(async () => {
    const success = await scenario('1.1.12');
    assert.equal(success.redirected, './?version=1.1.12');
    const stale = await scenario('1.1.0');
    assert.equal(stale.redirected, undefined);
    assert.match(stale.elements['#message'].textContent, /1\.1\.0/);
    assert.equal(stale.elements['#update'].disabled, false);
    const offline = await scenario('1.1.0', true);
    assert.equal(offline.redirected, undefined);
    assert.equal(offline.elements['#update'].disabled, false);
    console.log('PASS: update checks server and installed versions; stale/offline updates cannot report success');
})().catch(error => { console.error(error); process.exitCode = 1; });
