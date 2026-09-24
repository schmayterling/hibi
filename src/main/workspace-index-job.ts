/** Keeps one current scan and one latest follow-up; reset detaches an old workspace. */
type ActiveIndex<Request, Result> = {
  key: string
  latest: Request
  generation: number
  promise: Promise<Result | null>
}

export class LatestIndexJob<Request, Result> {
  private active: ActiveIndex<Request, Result> | undefined
  private capture: () => { key: string; request: Request } | null
  private run: (request: Request, current: () => boolean) => Promise<Result>

  constructor(
    capture: () => { key: string; request: Request } | null,
    run: (request: Request, current: () => boolean) => Promise<Result>,
  ) {
    this.capture = capture
    this.run = run
  }

  get running(): boolean {
    return this.active !== undefined
  }

  request(
    next: { key: string; request: Request } | null = this.capture(),
  ): Promise<Result | null> {
    if (!next) return Promise.resolve(null)
    if (this.active) {
      if (this.active.key !== next.key) {
        this.active.key = next.key
        this.active.latest = next.request
        this.active.generation++
      }
      return this.active.promise
    }
    const active: ActiveIndex<Request, Result> = {
      key: next.key,
      latest: next.request,
      generation: 0,
      promise: Promise.resolve(null),
    }
    this.active = active
    active.promise = this.drain(active)
    return active.promise
  }

  invalidate(): void {
    if (this.active) this.active.generation++
  }

  reset(): void {
    this.active = undefined
  }

  private async drain(active: ActiveIndex<Request, Result>) {
    try {
      while (this.active === active) {
        const request = active.latest
        const generation = active.generation
        let result: Result
        try {
          result = await this.run(
            request,
            () => this.active === active && active.generation === generation,
          )
        } catch (error) {
          if (this.active === active && active.generation === generation)
            throw error
          continue
        }
        if (this.active !== active) return null
        if (active.generation === generation) return result
        const next = this.capture()
        if (!next) return null
        active.key = next.key
        active.latest = next.request
      }
      return null
    } finally {
      if (this.active === active) this.active = undefined
    }
  }
}
