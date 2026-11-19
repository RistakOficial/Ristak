// Un push o poll que llega durante la apertura necesita una lectura posterior.
// Invalidar cada lectura en curso podía impedir que se pintara la primera.
export class ConversationReadQueue {
  private current: {
    contactId: string
    controller: AbortController
    request: Promise<void>
    followUp?: Promise<void>
  } | null = null

  cancel() {
    this.current?.controller.abort()
    this.current = null
  }

  run(contactId: string, opening: boolean, read: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const current = this.current
    if (!opening && current?.contactId === contactId) {
      current.followUp ??= current.request.then(() => {
        if (this.current !== current) return
        this.current = null
        return this.run(contactId, false, read)
      })
      return current.followUp
    }

    this.cancel()
    const controller = new AbortController()
    const request = read(controller.signal).finally(() => {
      if (this.current?.controller === controller && !this.current.followUp) this.current = null
    })
    this.current = { contactId, controller, request }
    return request
  }
}
