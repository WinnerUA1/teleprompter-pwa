const CACHE_PREFIX = "teleprompter-shell-";
const APP_VERSION = "1.1.12";
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./offline.js",
    "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("message", event => {
    if (event.data && event.data.type === "APPLY_UPDATE") {
        event.waitUntil(self.skipWaiting());
    }
    if (event.data && event.data.type === "GET_VERSION" && event.ports[0]) {
        event.ports[0].postMessage({ version: APP_VERSION });
    }
});

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(
        FILES.map(file => new Request(new URL(file, self.registration.scope), { cache: "reload" }))
    )));
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    const allowed = FILES.map(file => new URL(file, self.registration.scope).pathname);
    if (!allowed.includes(url.pathname)) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        return fetch(event.request);
    })());
});

