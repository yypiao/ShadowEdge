self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  event.source.postMessage({
    userAgent: self.navigator.userAgent,
    platform: self.navigator.platform,
    languages: Array.from(self.navigator.languages || []),
    hardwareConcurrency: self.navigator.hardwareConcurrency,
    deviceMemory: self.navigator.deviceMemory ?? null,
    webdriver: self.navigator.webdriver,
  });
});
