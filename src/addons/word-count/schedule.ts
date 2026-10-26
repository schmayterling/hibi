import type { countText } from './count'

/** Keep one count in flight and read source only after input becomes quiet. */
export function scheduleCounts<Request = string>(
  read: () => Request | null,
  send: (text: Request) => void,
  publish: (result: ReturnType<typeof countText>) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let sentGeneration = 0
  let pending = false
  let due = false
  let stopped = false
  const run = () => {
    if (stopped || pending || !due) return
    due = false
    const version = generation
    const text = read()
    if (text === null) return
    pending = true
    sentGeneration = version
    send(text)
  }
  return {
    refresh() {
      if (stopped) return
      generation++
      due = false
      clearTimeout(timer)
      timer = setTimeout(() => {
        due = true
        run()
      }, 250)
    },
    receive(result: ReturnType<typeof countText> | null) {
      if (stopped || !pending) return
      pending = false
      if (result && sentGeneration === generation) publish(result)
      run()
    },
    stop() {
      stopped = true
      due = false
      clearTimeout(timer)
    },
  }
}
