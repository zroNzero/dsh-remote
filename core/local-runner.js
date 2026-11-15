import { homedir } from 'node:os'
import { createExecutor } from './executor.js'
import { ERROR_CODES, remoteError } from './errors.js'
import { commandAllowed, resolveCwd } from './whitelist.js'

const STDERR_TAIL = 2048

export function createLocalRunner({ shell, config }) {
  const executor = createExecutor(shell)
  return {
    available: executor.available,
    async run({ command, cwd, timeoutMs, signal, onStdout, onStderr }) {
      if (!executor.available) throw remoteError(ERROR_CODES.EXEC, '无执行器')
      if (!commandAllowed(config.allowCommands, command)) {
        throw remoteError(ERROR_CODES.REJECTED, '命令未授权')
      }
      const workdir = await resolveCwd(cwd || homedir(), config.allowCwd)
      const requested = Number.isFinite(timeoutMs) ? timeoutMs : config.defaultTimeoutMs
      const effective = Math.max(100, Math.min(Math.trunc(requested), config.maxTaskMs))
      let stdout = ''
      let stderr = ''
      const result = await executor.run({
        command,
        cwd: workdir,
        timeoutMs: effective,
        signal,
        onStdout: (text) => {
          stdout += text
          if (onStdout) onStdout(text)
        },
        onStderr: (text) => {
          stderr += text
          if (onStderr) onStderr(text)
        },
      })
      return {
        ...result,
        cwd: workdir,
        stdout,
        stderr: tail(stderr, STDERR_TAIL),
      }
    },
  }
}

function tail(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(buffer.length - maxBytes).toString('utf8')
}
