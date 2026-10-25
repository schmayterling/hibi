export class ProviderLifetime {
  #epoch = 0

  get token() {
    return this.#epoch
  }

  begin(cancel: () => void) {
    const token = ++this.#epoch
    cancel()
    return this.current(token) ? token : null
  }

  current(token: number) {
    return this.#epoch === token
  }

  invalidate() {
    this.#epoch++
  }
}
