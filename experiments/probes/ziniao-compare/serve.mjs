/**
 * 紫鸟对照探针页服务（T0 C 组手动补测用）。
 * 用法：node experiments/probes/ziniao-compare/serve.mjs
 * 然后在紫鸟 EngTk2 环境的标签页打开 http://127.0.0.1:9567/probe
 * 页面自动采集主世界/Worker/WebRTC/ServiceWorker 指纹并回传，
 * 结果写入 experiments/probes/ziniao-compare/result-<ts>.json 并打印对比摘要。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, 'probe-page.html'), 'utf8');

const server = createServer((req, res) => {
  if (req.url === '/probe') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  if (req.url === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body);
      const file = join(HERE, `result-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(data, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      console.log('\n===== 紫鸟 EngTk2 采集结果 =====');
      console.log('UA:', data.main?.userAgent);
      console.log('platform:', data.main?.platform, '| hc:', data.main?.hardwareConcurrency, '| mem:', data.main?.deviceMemory, '| touch:', data.main?.maxTouchPoints);
      console.log('webdriver:', data.main?.webdriver, '| langs:', data.main?.languages?.join(','), '| tz:', data.main?.timezone);
      console.log('WebGL:', data.main?.webgl?.renderer);
      console.log('canvasHash:', data.main?.canvasHash, '| audioFp:', String(data.main?.audioFp).slice(0, 12));
      console.log('traps:', JSON.stringify(data.main?.traps));
      console.log('Worker:', JSON.stringify(data.worker));
      console.log('WebRTC:', JSON.stringify(data.webrtc));
      console.log('ServiceWorker:', data.serviceWorker);
      console.log('报告已存:', file);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(9567, '127.0.0.1', () => {
  console.log('探针页就绪。请在紫鸟 EngTk2 环境中打开:  http://127.0.0.1:9567/probe');
  console.log('（页面会自动采集并回传，完成后这里会打印结果）');
});
