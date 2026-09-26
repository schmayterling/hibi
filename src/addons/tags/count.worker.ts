import type { TagJob, TagResult } from './schedule'
import { noteTags } from './syntax'

self.onmessage = (event: MessageEvent<TagJob>) => {
  const { key, source, syntax } = event.data
  self.postMessage({ key, tags: noteTags(source, syntax) } satisfies TagResult)
}
