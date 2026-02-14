const CACHE_NAME = 'minis-repo-cache-c12ef47';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './assets/css/style.css',
    './assets/js/app.js',
    './manifest.json',
    './apps/repo-icon.png',
    './mini.json'
];

const SAFE_ASSET_PATTERNS = [
    /githubusercontent\.com\/.*\.png$/,
    /githubusercontent\.com\/.*\.jpg$/,
    /githubusercontent\.com\/.*\.jpeg$/
];

const OPAQUE_ORIGINS = ['objects.githubusercontent.com', 'raw.githubusercontent.com'];

let lastCleanup = 0;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE)));
});

self.addEventListener('message', event => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => key !== CACHE_NAME ? caches.delete(key) : null)
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        (async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            try {
                const networkResponse = await fetch(event.request, { signal: controller.signal });

                let canCache = false;
                if (networkResponse.status === 200) {
                    canCache = true;
                } else if (networkResponse.type === 'opaque') {
                    const url = new URL(event.request.url);
                    if (OPAQUE_ORIGINS.includes(url.hostname)) {
                        const isImageContext = event.request.destination === 'image';
                        const matchesPattern = SAFE_ASSET_PATTERNS.some(regex => regex.test(url.href));

                        if (isImageContext && matchesPattern) {
                            canCache = true;
                        }
                    }
                }

                if (canCache) {
                    const responseToCache = networkResponse.clone();
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(event.request, responseToCache);

                    const now = Date.now();
                    if (now - lastCleanup > 30000) {
                        limitCacheSize(CACHE_NAME, 50, ASSETS_TO_CACHE);
                        lastCleanup = now;
                    }
                }

                return networkResponse;
            } catch (error) {
                const cached = await caches.match(event.request);
                if (cached) return cached;

                // HIGH-5 FIX: Offline page now matches the dark/purple repo theme
                if (event.request.mode === 'navigate') {
                    return new Response(
                        `<!DOCTYPE html>
                        <html lang="en">
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>Offline — Mini's IPA Repo</title>
                            <style>
                                *{margin:0;padding:0;box-sizing:border-box}
                                body{
                                    background:linear-gradient(180deg,rgba(75,20,130,0.35)0%,rgba(50,12,90,0.18)280px,transparent 500px)no-repeat,#000;
                                    color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                                    display:flex;flex-direction:column;align-items:center;
                                    justify-content:center;min-height:100vh;text-align:center;
                                    padding:24px;-webkit-font-smoothing:antialiased;
                                }
                                h1{font-size:2em;font-weight:800;margin-bottom:8px;
                                    background:linear-gradient(270deg,#7c3aed,#c084fc,#e9d5ff,#a855f7);
                                    background-size:300% 300%;-webkit-background-clip:text;
                                    -webkit-text-fill-color:transparent;background-clip:text;
                                    animation:g 4s ease infinite}
                                @keyframes g{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
                                .sub{color:#b0b0b0;margin-bottom:24px;font-size:1em}
                                .icon{font-size:3em;margin-bottom:16px}
                                a{
                                    display:inline-block;padding:12px 28px;
                                    background:linear-gradient(135deg,#1db954,#1ed760);
                                    color:#fff;border-radius:14px;text-decoration:none;
                                    font-weight:700;font-size:0.95em;
                                    box-shadow:0 3px 12px rgba(29,185,84,0.3);
                                    transition:transform 0.2s ease,box-shadow 0.2s ease;
                                }
                                a:active{transform:scale(0.97)}
                                .hint{color:#666;font-size:0.8em;margin-top:20px}
                            </style>
                            <meta http-equiv="refresh" content="10">
                        </head>
                        <body>
                            <div class="icon">📡</div>
                            <h1>You're Offline</h1>
                            <p class="sub">Check your connection. This page auto-retries in 10s.</p>
                            <a href="./">Retry Now</a>
                            <p class="hint">Mini's IPA Repo</p>
                        </body>
                        </html>`,
                        { headers: { 'Content-Type': 'text/html' } }
                    );
                }
                return new Response('Network Error', { status: 408 });
            } finally {
                clearTimeout(timeoutId);
            }
        })()
    );
});

async function limitCacheSize(name, maxSize, exemptAssets = []) {
    if ('locks' in navigator) {
        await navigator.locks.request('cache-cleanup', async () => {
            await executeCacheCleanup(name, maxSize, exemptAssets);
        });
    } else {
        await executeCacheCleanup(name, maxSize, exemptAssets);
    }
}

async function executeCacheCleanup(name, maxSize, exemptAssets) {
    const cache = await caches.open(name);
    const keys = await cache.keys();

    const evictableKeys = keys.filter(req => {
        const url = new URL(req.url).pathname;
        return !exemptAssets.some(asset => url.endsWith(asset.replace('./', '')));
    });

    while (evictableKeys.length > maxSize) {
        const keyToDelete = evictableKeys.shift();
        await cache.delete(keyToDelete);
    }
}
