import type { BrowserProfile, ProxyHealth } from '@shadowedge/core';
import { ShadowEdgeError } from '@shadowedge/core';
import { auditFingerprint } from '@shadowedge/fingerprint';

/**
 * 启动前闸门（T4）：指纹一致 → 代理可达 → 地理对齐，任一不过拒绝启动。
 * 这是「环境不变脸」承诺的执行点，规则集中在这一个纯函数模块里，可评审可单测。
 */

export interface GateDeps {
  /** 代理健康检查（真实出口 IP/地理），由 handlers 注入。 */
  checkProxy: (proxyId: string) => Promise<ProxyHealth>;
}

export interface GateContext {
  profile: BrowserProfile;
  /** 排障专用：跳过代理两项检查（指纹一致性永不跳过）。 */
  ignoreProxyCheck?: boolean;
}

/** 时区地理一致性：代理出口时区必须与画像时区相同（IANA 名严格相等）。 */
function checkGeoAlignment(profile: BrowserProfile, health: ProxyHealth): void {
  const fpTz = profile.fingerprint.timezone;
  const exitTz = health.geo?.timezone;
  if (exitTz && exitTz !== fpTz) {
    throw new ShadowEdgeError(
      'E_PROXY_GEO_MISMATCH',
      `代理出口时区（${exitTz}）与指纹时区（${fpTz}）不一致，启动会暴露地理矛盾`,
      {
        details: {
          exitTimezone: exitTz,
          fingerprintTimezone: fpTz,
          exitIp: health.exitIp,
          country: health.geo?.country,
          suggestion: '更换与画像地区一致的代理，或将画像时区/语言调整为出口所在地',
        },
      },
    );
  }
}

export async function runLaunchGate(ctx: GateContext, deps: GateDeps): Promise<void> {
  // 第一检：指纹自身一致性（seed 可复现 + 维度自洽），永远不可跳过。
  const audit = auditFingerprint(ctx.profile.fingerprint);
  if (!audit.consistent) {
    throw new ShadowEdgeError('E_FINGERPRINT_INCONSISTENT', `环境「${ctx.profile.name}」指纹一致性审计未通过`, {
      details: { issues: audit.issues },
    });
  }

  if (!ctx.profile.proxyId || ctx.ignoreProxyCheck) return;

  // 第二检：代理可达性（真实出口探测）。
  let health: ProxyHealth;
  try {
    health = await deps.checkProxy(ctx.profile.proxyId);
  } catch (error) {
    if (error instanceof ShadowEdgeError) throw error;
    throw new ShadowEdgeError('E_PROXY_UNREACHABLE', `代理不可达: ${(error as Error).message}`, {
      retryable: true,
      cause: error,
    });
  }

  // 第三检：地理对齐。
  checkGeoAlignment(ctx.profile, health);
}
