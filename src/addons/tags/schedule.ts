import type { DocumentState } from '../../shared/desktop'

export type TagJob = { key: string; source: string }
export type TagResult = { key: string; tags: string[] }

/** A tab's content version advances on edits and external reloads; revision also advances on tab selection. */
export function tagVersion(
  document: Pick<DocumentState, 'tabId' | 'id' | 'contentVersion'>,
) {
  return JSON.stringify([document.tabId, document.id, document.contentVersion])
}

/** Delay source materialization until input settles and keep one parse in flight. */
export function scheduleTagCounts(
  read: () => TagJob | null,
  send: (job: TagJob) => void,
  publish: (tags: string[]) => void,
) {
  const cache = new Map<string, string[]>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: string | null = null
  let ready = false
  let pending = false
  let pendingKey: string | null = null
  let retried = false
  let stopped = false
  const run = () => {
    if (stopped || pending || !ready || !active) return
    const job = read()
    if (!job || job.key !== active) return
    ready = false
    pending = true
    pendingKey = job.key
    send(job)
  }
  return {
    refresh(key: string | null) {
      if (stopped || key === active) return
      active = key
      ready = false
      retried = false
      clearTimeout(timer)
      if (!key) {
        publish([])
        return
      }
      const known = cache.get(key)
      if (known) {
        publish(known)
        return
      }
      timer = setTimeout(() => {
        ready = true
        run()
      }, 250)
    },
    receive({ key, tags }: TagResult) {
      if (stopped || !pending || key !== pendingKey) return
      pending = false
      pendingKey = null
      retried = false
      cache.delete(key)
      cache.set(key, tags)
      const oldest = cache.keys().next().value
      if (cache.size > 8 && oldest) cache.delete(oldest)
      if (key === active) publish(tags)
      run()
    },
    fail(retry = true) {
      if (stopped || !pending) return
      pending = false
      pendingKey = null
      if (retry && !retried) {
        retried = true
        ready = true
        run()
      } else {
        ready = false
        if (active) publish([])
      }
    },
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
