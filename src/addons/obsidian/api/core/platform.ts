const platform = typeof navigator === 'undefined' ? '' : navigator.platform

export const Platform = Object.freeze({
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isMacOS: /Mac/i.test(platform),
  isWin: /Win/i.test(platform),
  isLinux: /Linux/i.test(platform),
  isSafari: false,
})
