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

// Phone notifications (sent by supabase/functions/notify when a plan is suggested or answered)
self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  const jobs = [self.registration.showNotification(d.title || "Daily", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    tag: d.tag,                     // a newer message about the same plan replaces the older one
    data: { url: d.url || "./" },
  })];
  if (typeof d.count === "number" && self.navigator.setAppBadge) {
    jobs.push((d.count ? self.navigator.setAppBadge(d.count) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(jobs));
});

// Tapping a notification opens the app on the Us tab
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (list.length) {
      list[0].postMessage({ open: "us" });
      return list[0].focus();
    }
    return self.clients.openWindow(url);
  }));
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
