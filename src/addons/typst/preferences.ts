export const settingsEvent = 'hibi:typst-settings'

export function systemCompilerEnabled() {
  return localStorage.getItem('typst:system-compiler') === 'true'
}

export function setSystemCompiler(enabled: boolean) {
  localStorage.setItem('typst:system-compiler', String(enabled))
  window.dispatchEvent(new Event(settingsEvent))
}
