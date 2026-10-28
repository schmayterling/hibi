export function alertMarker(text: string) {
  return /^\[!([a-z][a-z0-9-]*)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/i.exec(text)
}
