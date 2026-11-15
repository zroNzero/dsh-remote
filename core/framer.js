const FLUSH_BYTES = 64 * 1024
const FLUSH_MS = 50

export class StreamFramer {
  constructor({ stream, taskId, send, maxBytes = FLUSH_BYTES, intervalMs = FLUSH_MS }) {
    this.stream = stream
    this.taskId = taskId
    this.send = send
    this.maxBytes = maxBytes
    this.intervalMs = intervalMs
    this.buffer = Buffer.alloc(0)
    this.seq = 1
    this.first = true
    this.timer = null
    this.closed = false
  }

  push(text) {
    if (this.closed || typeof text !== 'string' || text.length === 0) return
    const chunk = Buffer.from(text, 'utf8')
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (this.first || this.buffer.length >= this.maxBytes) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.intervalMs)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.closed || this.buffer.length === 0) return
    while (this.buffer.length > 0) {
      let size = Math.min(this.buffer.length, this.maxBytes)
      while (size > 0 && (this.buffer[size] & 0xc0) === 0x80) size -= 1
      if (size === 0) size = Math.min(this.buffer.length, this.maxBytes)
      const data = this.buffer.subarray(0, size).toString('utf8')
      this.buffer = this.buffer.subarray(size)
      this.first = false
      this.send({
        type: `task.${this.stream}`,
        taskId: this.taskId,
        seq: this.seq++,
        data,
      })
      if (this.buffer.length < this.maxBytes) break
    }
    if (this.buffer.length > 0 && this.timer === null && !this.closed) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.intervalMs)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  end() {
    this.flush()
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
