import { describe, expect, it } from 'vitest';
import type { BrowserOpfsEntrySnapshot, BrowserStorageState } from '@shadowedge/core';
import { countOpfsFiles, withinOpfsBudget } from '../src/main/services/profile-state.js';

function stateWithOpfs(...origins: BrowserOpfsEntrySnapshot[][]): BrowserStorageState {
  return {
    cookies: [],
    origins: origins.map((opfs, index) => ({
      origin: `https://profile-${index}.example.com`,
      localStorage: [],
      opfs,
    })),
  };
}

describe('OPFS 快照安全预算', () => {
  it('文件数按全部 origin 汇总，不能通过拆站点绕过', () => {
    const first = Array.from({ length: 2000 }, (_, index): BrowserOpfsEntrySnapshot => ({
      path: `first/${index}.bin`, type: 'file', base64: 'AA==',
    }));
    const second: BrowserOpfsEntrySnapshot[] = [{ path: 'second.bin', type: 'file', base64: 'AA==' }];
    expect(countOpfsFiles(stateWithOpfs(first, second))).toBe(2001);
    expect(withinOpfsBudget(stateWithOpfs(first))).toBe(true);
    expect(withinOpfsBudget(stateWithOpfs(first, second))).toBe(false);
  });

  it('目录也计入条目预算，空文件与正常二进制内容保留', () => {
    const entries: BrowserOpfsEntrySnapshot[] = [
      { path: 'nested', type: 'directory' },
      { path: 'nested/state.bin', type: 'file', base64: Buffer.from([0, 255, 1]).toString('base64') },
    ];
    expect(withinOpfsBudget(stateWithOpfs(entries))).toBe(true);
    expect(countOpfsFiles(stateWithOpfs(entries))).toBe(1);
  });
});
