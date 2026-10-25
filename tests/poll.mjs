export { APP_STATE_TIMEOUT, waitForAsync } from './electron.mjs'
// The pinned compiler's cold font scan exceeded 30s on hosted Windows runners.
export const NATIVE_FONT_TIMEOUT = process.platform === 'win32' ? 60000 : 30000
export const NATIVE_COMPILER_READY_TIMEOUT = 15000 + NATIVE_FONT_TIMEOUT + 10000
