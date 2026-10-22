import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

let path
try {
  path = fileURLToPath(import.meta.resolve('@electron/notarize'))
} catch (error) {
  if (
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    process.env.NODE_ENV === 'production'
  )
    process.exit(0)
  throw error
}
const source = await readFile(path, 'utf8')
// notarize 2.5.0 never calls promise-retry's retry callback after stapling fails.
const before = `(0, promise_retry_1.default)(() => (0, staple_1.stapleApp)({ appPath }), {
            retries: 3,
        })`
const after = `(0, promise_retry_1.default)((retry) => (0, staple_1.stapleApp)({ appPath }).catch((error) => {
            if (/code: 68\\b[\\s\\S]*Domain=NSURLErrorDomain\\s+Code=-1005(?:\\s|$)/.test(error.message))
                return retry(error);
            throw error;
        }), {
            retries: 3,
            factor: 1,
            minTimeout: 10000,
        })`
if (!source.includes(after)) {
  if (!source.includes(before))
    throw new Error(
      'Electron notarize changed. Review the stapling retry patch before updating it.',
    )
  await writeFile(path, source.replace(before, after))
}
