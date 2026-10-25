export const compareWorkspacePaths = new Intl.Collator().compare
export const compareWorkspaceNames = new Intl.Collator(undefined, {
  numeric: true,
}).compare
