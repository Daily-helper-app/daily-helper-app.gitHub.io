// Offline support: keeps a copy of the app's files on the phone.
// Online: always loads the newest files (so updates arrive by themselves) and refreshes the copy.
// Offline or very slow signal (over 3 s): uses the saved copy.
const CACHE = "daily-app";
const FILES = ["./", "index.html", "app.css", "app.js", "sync.js", "together.js", "together-view.js", "config.js",
  "vendor/supabase-2.117.3.js",
  "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  // Only this app's own files; anything else is left alone
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {});
  const timeout = new Promise(resolve => setTimeout(resolve, 3000, null));
  const fast = await Promise.race([network.catch(() => null), timeout]);
  if (fast) return fast;
  return (await cache.match(req, { ignoreSearch: true })) || network;
}
