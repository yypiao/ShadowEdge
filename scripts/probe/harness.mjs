import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClientHintHeaders, generateFingerprint } from '../../packages/fingerprint/dist/index.js';
import { BrowserKernel, ChromiumCdpDriver } from '../../packages/kernel/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'probe-page.html'), 'utf8');
const WORKER = readFileSync(join(HERE, 'probe-worker.js'), 'utf8');
const SERVICE_WORKER = readFileSync(join(HERE, 'probe-sw.js'), 'utf8');

function profile(id, seed, userDataDir) {
  return {
    id,
    orgId: 'local-probe',
    name: id,
    kernel: 'chromium-cdp',
    fingerprint: generateFingerprint({ seed, platform: 'host', catalogVersion: '131.0.6778.86' }),
    ownerId: 'local-probe',
    sharedWith: [],
    storage: { userDataDir, remoteRevision: 0, syncMode: 'local-only' },
    startupUrls: [],
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const HIGH_ENTROPY_HEADERS = [
  'sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version',
  'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model',
];

async function serveProbe() {
  let initialNavigationHeaders;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/' && !initialNavigationHeaders) initialNavigationHeaders = { ...request.headers };
    const body = path === '/worker.js' ? WORKER
      : path === '/sw.js' ? SERVICE_WORKER
        : path === '/headers' ? JSON.stringify(request.headers) : PAGE;
    response.writeHead(200, {
      'content-type': path === '/headers' ? 'application/json; charset=utf-8'
        : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'service-worker-allowed': '/',
      'accept-ch': HIGH_ENTROPY_HEADERS.join(', '),
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('探针服务器端口不可用');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    initialNavigationHeaders: () => initialNavigationHeaders ?? {},
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}


async function evaluateMain(page, fn, argument) {
  console.log('[probe-cdp] new-session');
  const session = await page.context().newCDPSession(page);
  try {
    const expression = `(${fn.toString()})(${argument === undefined ? '' : JSON.stringify(argument)})`;
    console.log('[probe-cdp] runtime-evaluate');
    const evaluated = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log('[probe-cdp] evaluate-complete');
    if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails));
    return evaluated.result.value;
  } finally {
    console.log('[probe-cdp] detach');
    await session.detach();
    console.log('[probe-cdp] detach-complete');
  }
}

async function collect(page) {
  const forwardConsole = (message) => console.log(`[probe-page] ${message.text()}`);
  page.on('console', forwardConsole);
  try {
    return await evaluateMain(page, async () => {
    console.log('collect-worker-start');
    const workerMessage = (worker) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker probe timeout')), 5000);
      worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); worker.terminate(); };
      worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage('collect');
    });
    const worker = await workerMessage(new Worker('/worker.js'));
    console.log('collect-service-worker-start');
    const registration = await navigator.serviceWorker.register('/sw.js');
    let serviceWorker = registration.active ?? registration.waiting ?? registration.installing;
    if (!serviceWorker) throw new Error('service worker is not registered');
    if (serviceWorker.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('service worker activation timeout')), 5000);
        serviceWorker.addEventListener('statechange', function listener() {
          if (serviceWorker.state === 'activated') {
            clearTimeout(timer);
            serviceWorker.removeEventListener('statechange', listener);
            resolve();
          }
        });
      });
    }
    const swPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('service worker probe timeout')), 5000);
      navigator.serviceWorker.addEventListener('message', function listener(event) {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', listener);
        resolve(event.data);
      }, { once: true });
    });
    serviceWorker.postMessage('collect');
    const serviceWorkerResult = await swPromise;
    await registration.unregister();
    console.log('collect-service-worker-complete');

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    let webgl = null;
    if (gl) {
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
      };
    }
    const Audio = globalThis.OfflineAudioContext;
    console.log('collect-audio-start');
    let audio = null;
    if (Audio) {
      const context = new Audio(1, 128, 44100);
      const oscillator = context.createOscillator();
      oscillator.connect(context.destination);
      oscillator.start();
      const rendered = await context.startRendering();
      const channel = rendered.getChannelData(0);
      audio = Array.from(channel.slice(0, 32));
    }
    const candidates = [];
    console.log('collect-webrtc-start');
    if (globalThis.RTCPeerConnection) {
      const connection = new RTCPeerConnection({ iceServers: [] });
      connection.createDataChannel('probe');
      connection.onicecandidate = (event) => {
        if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
      };
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 300));
      connection.close();
    }
    const network = await fetch('/headers', { cache: 'no-store' }).then((response) => response.json());
    // 临时端口和 Referer 属于每次探针运行的传输细节，不是环境画像；
    // 不把它们写入稳定哈希或跨版本差异，避免假阳性。
    delete network.host;
    delete network.referer;
    console.log('collect-complete');
    return {
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: Array.from(navigator.languages),
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        webdriver: navigator.webdriver,
        plugins: Array.from(navigator.plugins, (plugin) => plugin.name),
        mimeTypes: Array.from(navigator.mimeTypes, (mime) => mime.type),
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
        devicePixelRatio: globalThis.devicePixelRatio,
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webgl,
      audio,
      worker,
      serviceWorker: serviceWorkerResult,
      network,
      webrtcCandidates: candidates,
    };
    });
  } finally {
    page.off('console', forwardConsole);
  }
}



function expectedProfileNavigator(fingerprint) {
  return {
    userAgent: fingerprint.userAgent,
    platform: fingerprint.platform === 'macos' ? 'MacIntel' : fingerprint.platform === 'windows' ? 'Win32' : 'Linux x86_64',
    languages: fingerprint.languages,
    hardwareConcurrency: fingerprint.hardware.hardwareConcurrency,
    deviceMemory: fingerprint.hardware.deviceMemoryGb,
  };
}

function comparableWorkerNavigator(value) {
  return {
    userAgent: value.userAgent,
    platform: value.platform,
    languages: value.languages,
    hardwareConcurrency: value.hardwareConcurrency,
    deviceMemory: value.deviceMemory,
  };
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function privateIpv4(value) {
  const match = value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (!match) return false;
  const parts = match[0].split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function reportBuilder(startedAt, config) {
  const checks = [];
  return {
    check(id, category, passed, details) {
      checks.push({ id, category, passed: Boolean(passed), details });
    },
    skip(id, category, reason) {
      checks.push({ id, category, skipped: true, reason });
    },
    finish() {
      const applicable = checks.filter((check) => !check.skipped);
      const failed = applicable.filter((check) => !check.passed);
      return {
        format: 'shadowedge-probe-report',
        version: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        config,
        summary: {
          ok: failed.length === 0,
          total: checks.length,
          passed: applicable.length - failed.length,
          failed: failed.length,
          skipped: checks.length - applicable.length,
          passRate: applicable.length ? Number((((applicable.length - failed.length) / applicable.length) * 100).toFixed(2)) : 0,
        },
        checks,
      };
    },
  };
}

async function seedOriginState(context, page, origin, token) {
  await context.addCookies([{ name: 'probe-isolation', value: token, url: origin }]);
  await evaluateMain(page, async (value) => {
    localStorage.setItem('probe isolation', value);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('shadowedge-probe', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put(value, 'token');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, token);
}

async function readOriginState(page) {
  return evaluateMain(page, async () => ({
    localStorage: localStorage.getItem('probe isolation'),
    indexedDB: await new Promise((resolve, reject) => {
      const request = indexedDB.open('shadowedge-probe');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) { db.close(); resolve(null); return; }
        const get = db.transaction('state').objectStore('state').get('token');
        get.onsuccess = () => { resolve(get.result ?? null); db.close(); };
        get.onerror = () => reject(get.error);
      };
    }),
  }));
}

export async function runProbeSuite(options) {
  const startedAt = new Date().toISOString();
  const stage = (name) => console.log(`[probe-stage] ${name}`);
  const restarts = options.restarts ?? 20;
  if (!Number.isInteger(restarts) || restarts < 0 || restarts > 100) throw new Error('restarts 必须是 0..100 的整数');
  if (!options.executablePath) throw new Error('必须提供 Chromium executablePath');
  const isolationEnabled = options.isolation !== false;
  const stabilityEnabled = options.stability !== false && restarts > 0;
  const root = mkdtempSync(join(tmpdir(), 'shadowedge-probe-'));
  const server = await serveProbe();
  const kernel = new BrowserKernel({
    drivers: [new ChromiumCdpDriver({ executablePath: options.executablePath, fallbackToPatchright: false })],
  });
  const a = profile('probe-a', 'shadowedge-probe-a', join(root, 'a'));
  const b = profile('probe-b', 'shadowedge-probe-b', join(root, 'b'));
  const report = reportBuilder(startedAt, {
    executablePath: options.executablePath,
    restarts: stabilityEnabled ? restarts : 0,
    isolation: isolationEnabled,
    headless: false,
  });
  let baseline;
  let reportValue;
  try {
    stage('launch-a');
    await kernel.launch(a, { profileId: a.id, headless: false });
    const contextA = kernel.getAutomationContext(a.id);
    const pageA = contextA.pages()[0] ?? await contextA.newPage();
    stage('goto-a');
    await pageA.goto(server.origin);
    stage('collect-a');
    baseline = await collect(pageA);
    stage('baseline-complete');
    report.check('main-image', 'fingerprint', stableHash(comparableWorkerNavigator(baseline.navigator)) === stableHash(expectedProfileNavigator(a.fingerprint)), { expected: expectedProfileNavigator(a.fingerprint), actual: comparableWorkerNavigator(baseline.navigator) });
    report.check('navigator.webdriver', 'automation', baseline.navigator.webdriver === false, baseline.navigator.webdriver);
    report.check('worker-image', 'worker', stableHash(comparableWorkerNavigator(baseline.worker)) === stableHash(comparableWorkerNavigator(baseline.navigator)), { expected: comparableWorkerNavigator(baseline.navigator), actual: comparableWorkerNavigator(baseline.worker) });
    report.check('service-worker-image', 'worker', stableHash(comparableWorkerNavigator(baseline.serviceWorker)) === stableHash(comparableWorkerNavigator(baseline.worker)), baseline.serviceWorker);
    report.check('worker-automation', 'automation', baseline.worker.webdriver !== true && baseline.serviceWorker.webdriver !== true, { worker: baseline.worker.webdriver ?? null, serviceWorker: baseline.serviceWorker.webdriver ?? null });
    const clientHints = buildClientHintHeaders(a.fingerprint);
    report.check('network-request-image', 'network',
      baseline.network['user-agent'] === a.fingerprint.userAgent
        && baseline.network['sec-ch-ua'] === clientHints['sec-ch-ua']
        && baseline.network['sec-ch-ua-platform'] === clientHints['sec-ch-ua-platform']
        && baseline.network['sec-ch-ua-mobile'] === clientHints['sec-ch-ua-mobile']
        && baseline.network['accept-language']?.startsWith(a.fingerprint.languages[0]),
      baseline.network);
    const fullVersionBrands = a.fingerprint.userAgentData.brands.map(({ brand, version }) => ({
      brand,
      version: version === a.fingerprint.userAgentData.fullVersion.split('.')[0]
        ? a.fingerprint.userAgentData.fullVersion : version.includes('.') ? version : `${version}.0.0.0`,
    }));
    report.check('network-client-hints-negotiation', 'network',
      fullVersionBrands.every(({ brand, version }) => baseline.network['sec-ch-ua-full-version-list']?.includes(`"${brand}";v="${version}"`))
        && baseline.network['sec-ch-ua-platform-version'] === `"${a.fingerprint.userAgentData.platformVersion}"`
        && baseline.network['sec-ch-ua-arch'] === `"${a.fingerprint.userAgentData.architecture}"`
        && baseline.network['sec-ch-ua-bitness'] === `"${a.fingerprint.userAgentData.bitness}"`
        && baseline.network['sec-ch-ua-model'] === `"${a.fingerprint.userAgentData.model}"`,
      { expected: fullVersionBrands, actual: baseline.network });
    const initialHeaders = server.initialNavigationHeaders();
    report.check('network-first-request-minimal', 'network',
      HIGH_ENTROPY_HEADERS.every((name) => initialHeaders[name] === undefined),
      Object.fromEntries(Object.entries(initialHeaders).filter(([name]) => name.startsWith('sec-ch-') || name === 'user-agent')));
    report.check('webrtc-private-ip', 'network', !baseline.webrtcCandidates.some(privateIpv4), baseline.webrtcCandidates);
    if (options.expectedExitIp) {
      const response = await evaluateMain(pageA, async () => (await fetch('https://api.ipify.org')).text());
      report.check('proxy-exit-ip', 'network', response === options.expectedExitIp, { actual: response, expected: options.expectedExitIp });
    } else {
      report.skip('proxy-exit-ip', 'network', '未提供 --expected-exit-ip；本地探针不伪造代理出口结论');
    }

    if (isolationEnabled) {
      stage('seed-a');
      await seedOriginState(contextA, pageA, server.origin, 'profile-a-token');
      stage('launch-b');
      await kernel.launch(b, { profileId: b.id, headless: false });
      const contextB = kernel.getAutomationContext(b.id);
      const pageB = contextB.pages()[0] ?? await contextB.newPage();
      stage('goto-b');
      await pageB.goto(server.origin);
      stage('collect-b');
      const bSnapshot = await collect(pageB);
      stage('seed-b');
      await seedOriginState(contextB, pageB, server.origin, 'profile-b-token');
      stage('read-isolation-state');
      const [stateA, stateB, cookiesA, cookiesB] = await Promise.all([
        readOriginState(pageA), readOriginState(pageB), contextA.cookies([server.origin]), contextB.cookies([server.origin]),
      ]);
      report.check('cookie-isolation', 'isolation', cookiesA[0]?.value === 'profile-a-token' && cookiesB[0]?.value === 'profile-b-token', { a: cookiesA, b: cookiesB });
      report.check('local-storage-isolation', 'isolation', stateA.localStorage === 'profile-a-token' && stateB.localStorage === 'profile-b-token', stateB);
      report.check('indexed-db-isolation', 'isolation', stateA.indexedDB === 'profile-a-token' && stateB.indexedDB === 'profile-b-token', stateB);
      report.check('fingerprint-isolation', 'isolation', stableHash(baseline) !== stableHash(bSnapshot), { a: stableHash(baseline), b: stableHash(bSnapshot) });
      report.check('worker-fingerprint-isolation', 'isolation', stableHash(baseline.worker) !== stableHash(bSnapshot.worker), { a: baseline.worker, b: bSnapshot.worker });
      stage('close-b');
      await kernel.close(b.id);
      stage('isolation-complete');
    }

    if (stabilityEnabled) {
      let stable = true;
      const failures = [];
      for (let index = 1; index <= restarts; index += 1) {
        stage(`restart-${index}-close`);
        await kernel.close(a.id);
        stage(`restart-${index}-launch`);
        await kernel.launch(a, { profileId: a.id, headless: false });
        const context = kernel.getAutomationContext(a.id);
        const page = context.pages()[0] ?? await context.newPage();
        stage(`restart-${index}-collect`);
        await page.goto(server.origin);
        const current = await collect(page);
        if (stableHash(current) !== stableHash(baseline)) {
          stable = false;
          failures.push({ restart: index, expected: stableHash(baseline), actual: stableHash(current), snapshot: current });
        }
      }
      report.check('20-restart-zero-drift', 'stability', stable, { requestedRestarts: restarts, failures });
    }
  } catch (error) {
    report.check('harness-execution', 'harness', false, error instanceof Error ? error.stack : String(error));
  } finally {
    stage('cleanup');
    await kernel.closeAll().catch(() => undefined);
    await server.close().catch(() => undefined);
    reportValue = report.finish();
    if (options.outputPath) {
      mkdirSync(dirname(options.outputPath), { recursive: true });
      const temporary = `${options.outputPath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(reportValue, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, options.outputPath);
    }
    rmSync(root, { recursive: true, force: true });
  }
  return reportValue;
}
