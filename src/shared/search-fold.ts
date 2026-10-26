// Greek final sigma is the only lowercase mapping that depends on context.
// Equating σ and ς lets whole strings and streamed characters compare alike.
export const foldSearchText = (text: string): string =>
  text.toLowerCase().replaceAll('ς', 'σ')
