import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dialog } from 'electron';
import { ShadowEdgeError } from '@shadowedge/core';

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export async function saveProfileBackupDialog(
  fileName: string,
  contents: string,
): Promise<string | undefined> {
  const result = await dialog.showSaveDialog({
    defaultPath: fileName,
    filters: [{ name: 'ShadowEdge 加密环境备份', extensions: ['sebackup'] }],
  });
  if (result.canceled || !result.filePath) return undefined;
  writeFileSync(result.filePath, contents, { encoding: 'utf8', mode: 0o600 });
  return result.filePath;
}

export async function readProfileBackupDialog(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'ShadowEdge 加密环境备份', extensions: ['sebackup'] }],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return undefined;
  if (statSync(path).size > MAX_BACKUP_BYTES) {
    throw new ShadowEdgeError('E_BACKUP_INVALID', '备份文件超过 20MB 限制');
  }
  return readFileSync(path, 'utf8');
}
