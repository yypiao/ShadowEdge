import type { BrowserProfile, LaunchResult, ProxyCredential, Uuid } from '@shadowedge/core';

export interface ShadowEdgeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** ShadowEdge OpenAPI 客户端。 */
export class ShadowEdgeClient {
  private fetchImpl: typeof fetch;

  constructor(private options: ShadowEdgeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
        ...init?.headers,
      },
    });
    if (!res.ok) throw new Error(`ShadowEdge API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  listProfiles(): Promise<BrowserProfile[]> {
    return this.request('/v1/profiles');
  }

  getProfile(id: Uuid): Promise<BrowserProfile> {
    return this.request(`/v1/profiles/${id}`);
  }

  launchProfile(id: Uuid): Promise<LaunchResult> {
    return this.request(`/v1/profiles/${id}/launch`, { method: 'POST' });
  }

  listProxies(): Promise<ProxyCredential[]> {
    return this.request('/v1/proxies');
  }
}
