export type TypstResult = {
  svg?: string
  pages?: number
  dependencies?: string[] | null
  diagnostics: { message: string; severity: 'error' | 'warning' }[]
}
