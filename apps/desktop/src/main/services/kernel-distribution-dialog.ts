import { dialog } from 'electron';

export async function selectKernelPackageDialog(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'ShadowEdge 签名内核包', extensions: ['zip'] }],
  });
  return result.canceled ? undefined : result.filePaths[0];
}
