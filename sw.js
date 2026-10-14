// Offline shell for Flick. Network first, so updates land immediately; the cache answers when offline.
const CACHE = 'flick-v5'
const SHELL = ['./', './index.html', './styles.css', './net.js', './app.js', './vendor/qrcode.min.js', './manifest.json', './icon.svg']
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))))
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return // never cache IP lookups, star counts or anything else

  event.respondWith(caches.open(CACHE).then(async cache => {
    try {
      const response = await fetch(request)
      if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone())
      return response
    } catch {
      return (await cache.match(request, { ignoreSearch: sameOrigin })) ||
        (request.mode === 'navigate' ? cache.match('./index.html') : Response.error())
    }
  }))
})
