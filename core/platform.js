// HarmonyOS/Android DSH starts node from <engine>/bin/node and puts /system/bin on PATH.
export function isMobileRuntime(
  execPath = process.execPath,
  platform = process.platform,
  pathEnv = process.env.PATH,
) {
  const exec = String(execPath || '').replace(/\\/g, '/')
  if (/^\/.*\/engine\/bin\/node(?:\.exe)?$/i.test(exec)) return true
  if (platform === 'win32') return false
  if (/\/engine\/bin\/node(?:\.exe)?$/i.test(exec)) return true
  if (platform === 'android') return true
  const dshHome = String(process.env.DSH_HOME || '').replace(/\\/g, '/')
  if (/(^|\/)engine\/home\/?$/i.test(dshHome)) return true
  const parts = String(pathEnv || '').split(':')
  if (parts.includes('/system/bin')) return true
  return false
}

export function runtimeKind(options) {
  return isMobileRuntime(options && options.execPath, options && options.platform, options && options.pathEnv)
    ? 'mobile'
    : 'desktop'
}
