// Minimal service worker: makes the app installable as a PWA.
// All data lives on the local server, so requests pass straight through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default network handling */ });
