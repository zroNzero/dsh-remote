import { ERROR_CODES, remoteError } from './errors.js'

export function createExecutor(shell) {
  const available = Boolean(shell && typeof shell.resolve === 'function' && typeof shell.execute === 'function')
  return {
    available,
    async run({ command, cwd, timeoutMs, signal, onStdout, onStderr }) {
      if (!available) throw remoteError(ERROR_CODES.EXEC, '无执行器')
      let spec
      try {
        spec = shell.resolve({
          command,
          workdir: cwd,
          timeoutMs,
          signal,
          onExpiry: 'kill',
        })
      } catch (error) {
        throw remoteError(ERROR_CODES.EXEC, '执行器拒绝', { details: { cause: error.code || error.message } })
      }
      let execution
      try {
        execution = await shell.execute(spec)
      } catch (error) {
        throw remoteError(ERROR_CODES.EXEC, '执行器启动失败', { details: { cause: error.code || error.message } })
      }
      const started = Date.now()
      let stdoutOffset = 0
      let stderrOffset = 0
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutLossy = false
      let stderrLossy = false
      const stdoutReader = execution && execution.observed ? execution.observed.stdout : undefined
      const stderrReader = execution && execution.observed ? execution.observed.stderr : undefined

      const pump = () => {
        if (stdoutReader && typeof stdoutReader.readFrom === 'function') {
          try {
            const read = stdoutReader.readFrom(stdoutOffset)
            stdoutOffset = read.nextOffset
            if (read.lossy) stdoutLossy = true
            if (read.text) {
              stdoutBytes += Buffer.byteLength(read.text)
              if (onStdout) onStdout(read.text)
            }
          } catch { /* 读空 */ }
        }
        if (stderrReader && typeof stderrReader.readFrom === 'function') {
          try {
            const read = stderrReader.readFrom(stderrOffset)
            stderrOffset = read.nextOffset
            if (read.lossy) stderrLossy = true
            if (read.text) {
              stderrBytes += Buffer.byteLength(read.text)
              if (onStderr) onStderr(read.text)
            }
          } catch { /* 读空 */ }
        }
      }

      const timer = setInterval(pump, 20)
      if (typeof timer.unref === 'function') timer.unref()
      let result
      try {
        if (execution && typeof execution.result === 'function') result = await execution.result()
        else if (execution && execution.done) {
          await execution.done
          result = {
            exitCode: execution.exitCode,
            signal: execution.signal,
            timedOut: false,
            aborted: false,
          }
        } else {
          throw new Error('执行器无结果')
        }
      } catch (error) {
        clearInterval(timer)
        throw remoteError(ERROR_CODES.EXEC, '执行器失败', { details: { cause: error.code || error.message } })
      } finally {
        clearInterval(timer)
        pump()
      }
      return {
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        signal: result.signal || null,
        timedOut: Boolean(result.timedOut),
        aborted: Boolean(result.aborted),
        durationMs: Date.now() - started,
        stdoutBytes,
        stderrBytes,
        stdoutLossy,
        stderrLossy,
      }
    },
  }
}
