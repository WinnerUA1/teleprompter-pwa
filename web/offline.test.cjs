const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
    const listeners = {};
    const entries = new Map();
    const base = "https://prompter.test/";
    let online = true;
    let claimed = false;
    const cache = {
        async addAll(files) {
            for (const file of files) {
                assert.equal(file.cache, "reload");
                const url = new URL(file.url, base);
                const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
                entries.set(url.pathname, fs.readFileSync(path.join(__dirname, name)));
            }
        },
        async match(request) {
            const url = new URL(typeof request === "string" ? request : request.url, base);
            return entries.get(url.pathname);
        }
    };
    const deleted = [];
    const context = {
        URL, Request,
        self: {
            location: { origin: new URL(base).origin }, registration: { scope: base },
            clients: { async claim() { claimed = true; } },
            addEventListener(name, fn) { listeners[name] = fn; }
        },
        caches: {
            async open() { return cache; },
            async keys() { return ["teleprompter-shell-old", "other-app"]; },
            async delete(key) { deleted.push(key); }
        },
        async fetch() { if (!online) throw new Error("offline"); return "network"; }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "sw.js"), "utf8"), context);
    let pending;
    listeners.install({ waitUntil(promise) { pending = promise; } });
    await pending;
    assert.equal(entries.size, 8);
    const html = entries.get("/index.html").toString();
    let version;
    listeners.message({ data: { type: "GET_VERSION" }, ports: [{ postMessage(data) { version = data.version; } }] });
    assert(html.includes(`name="app-version" content="${version}"`));
    assert(html.includes(`Версія ${version}`));
    listeners.activate({ waitUntil(promise) { pending = promise; } });
    await pending;
    assert(claimed);
    assert.deepEqual(deleted, ["teleprompter-shell-old"]);
    online = false;
    for (const pathname of entries.keys()) {
        let result;
        listeners.fetch({ request: { method: "GET", url: base.slice(0, -1) + pathname + "?test=1" }, respondWith(promise) { result = promise; } });
        assert(Buffer.isBuffer(await result), `Offline resource missing: ${pathname}`);
    }
    let intercepted = false;
    listeners.fetch({ request: { method: "GET", url: base + "cert/teleprompter.pfx" }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.display, "standalone");
    for (const icon of manifest.icons) {
        const png = fs.readFileSync(path.join(__dirname, icon.src));
        const size = Number(icon.sizes.split("x")[0]);
        assert.equal(png.readUInt32BE(16), size);
        assert.equal(png.readUInt32BE(20), size);
    }
    console.log("PASS: complete offline shell, offline navigation/assets, cache cleanup, standalone manifest, PNG icons");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
