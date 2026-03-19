// @ts-nocheck
export const fileUploadSizeLimit = 50 * 1024 * 1024;

export async function mkdirIfNeeded() {}

export async function writeTempFile(path, data) {
  const writer = globalThis.writeFile;
  if (typeof writer !== 'function')
    throw new Error('writeFile() is not available in the QuickJS sandbox');
  return await writer(path, data);
}
