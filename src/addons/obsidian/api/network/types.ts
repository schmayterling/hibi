// Public API shapes are MIT licensed; see ../../LICENSE.obsidian-api.md.
export interface RequestUrlParam {
  url: string
  method?: string
  contentType?: string
  body?: string | ArrayBuffer
  headers?: Record<string, string>
  throw?: boolean
}
export interface RequestUrlResponse {
  status: number
  headers: Record<string, string>
  arrayBuffer: ArrayBuffer
  text: string
  readonly json: unknown
}
export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  readonly arrayBuffer: Promise<ArrayBuffer>
  readonly text: Promise<string>
  readonly json: Promise<unknown>
}
export interface RequestUrlBytes {
  status: number
  headers: Record<string, string>
  arrayBuffer: ArrayBuffer
}
