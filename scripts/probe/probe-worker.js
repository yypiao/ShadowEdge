self.onmessage = () => {
  self.postMessage({
    userAgent: self.navigator.userAgent,
    platform: self.navigator.platform,
    languages: Array.from(self.navigator.languages || []),
    hardwareConcurrency: self.navigator.hardwareConcurrency,
    deviceMemory: self.navigator.deviceMemory ?? null,
    webdriver: self.navigator.webdriver,
  });
};
