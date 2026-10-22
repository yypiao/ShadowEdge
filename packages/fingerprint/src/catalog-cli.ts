import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChromeCatalog, parseChromeStableVersion } from './catalog.js';

const CHROME_FOR_TESTING =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

async function fetchStableVersion(): Promise<string> {
  const response = await fetch(CHROME_FOR_TESTING, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Chrome for Testing API HTTP ${response.status}`);
  return parseChromeStableVersion(await response.json());
}

async function main(): Promise<void> {
  const version = arg('--version') ?? (await fetchStableVersion());
  const out = resolve(
    arg('--out') ?? fileURLToPath(new URL('../catalog/chrome-stable.json', import.meta.url)),
  );
  const catalog = buildChromeCatalog(version, {
    generatedAt: new Date().toISOString(),
    source: CHROME_FOR_TESTING,
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(`[catalog] Chrome ${catalog.chromeVersion} -> ${out}`);
}

main().catch((error: unknown) => {
  console.error(`[catalog] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
