import { Resolver } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import type { ProxyHealth } from '@shadowedge/core';

type RiskSource = NonNullable<ProxyHealth['risk']>['sources'][number];
type SourceId = RiskSource['id'];

interface DnsError extends Error {
  code?: string;
}

export interface BlacklistCheckOptions {
  timeoutMs?: number;
  /** 测试注入 DNS 结果；生产默认使用系统 resolver，查询只包含出口 IP 的反向 DNSBL 名称。 */
  resolve4?: (hostname: string) => Promise<readonly string[]>;
  now?: () => number;
}

const SOURCES: ReadonlyArray<{ id: SourceId; zone: string; listedAnswers: readonly string[] }> = [
  {
    id: 'spamhaus-zen',
    zone: 'zen.spamhaus.org',
    // 127.255.255.* 是查询错误/公共 resolver 限制，不是 IP 被列名。
    listedAnswers: ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.9', '127.0.0.10', '127.0.0.11'],
  },
  { id: 'spamcop', zone: 'bl.spamcop.net', listedAnswers: ['127.0.0.2'] },
];

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? (error as DnsError).code : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('DNSBL 查询超时') as DnsError;
          error.code = 'ETIMEDOUT';
          reject(error);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** DNSBL 只说明垃圾邮件/滥用名单命中情况，不等同于电商平台风控结论。 */
export async function inspectIpBlacklist(
  exitIp: string,
  options: BlacklistCheckOptions = {},
): Promise<RiskSource[]> {
  if (!isIPv4(exitIp)) {
    return SOURCES.map((source) => ({
      id: source.id,
      status: 'unknown',
      detail: '仅支持 IPv4 DNSBL 查询',
    }));
  }
  const resolver = options.resolve4 ? undefined : new Resolver();
  const resolve4 = options.resolve4 ?? ((hostname: string) => resolver!.resolve4(hostname));
  const timeoutMs = options.timeoutMs ?? 4000;
  const prefix = exitIp.split('.').reverse().join('.');
  return Promise.all(
    SOURCES.map(async (source): Promise<RiskSource> => {
      try {
        const answers = await withTimeout(resolve4(`${prefix}.${source.zone}`), timeoutMs);
        if (answers.some((answer) => source.listedAnswers.includes(answer))) {
          return { id: source.id, status: 'listed', detail: 'DNSBL 返回名单记录' };
        }
        return {
          id: source.id,
          status: 'unknown',
          detail: answers.length > 0 ? 'DNSBL 返回查询错误或未识别记录' : 'DNSBL 返回空记录',
        };
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENOENT') {
          return { id: source.id, status: 'clear' };
        }
        return {
          id: source.id,
          status: 'unknown',
          detail: code === 'ETIMEDOUT' ? 'DNSBL 查询超时' : 'DNSBL 查询不可用',
        };
      }
    }),
  );
}
