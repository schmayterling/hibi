/** Keep the formatted renderer's preload graph behind editor demand. */
export const load = async () =>
  (await import('./formatted-flavor')).registerFormattedFlavor
