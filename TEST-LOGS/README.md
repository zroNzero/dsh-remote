# TEST-LOGS 日志归档说明

本目录只放测试时产生的日志、截图和返回原文。当前目录内没有实际测试日志。

## 1. 目录结构

```text
TEST-LOGS/
  README.md
  ROUND-<YYYYMMDD>-<NN>/
    ENV/
      env.txt
      pc-ipv6.txt
      pc-plugin.png
      phone-plugin.png
      phone-ipv6.png
      versions.txt
      pc-config.redacted.json
      phone-config.redacted.json
    TC-00/
      meta.txt
      payload.txt
      pc-host.log
      pc-host.stdout.log
      pc-host.stderr.log
      pc-client-console.log
      pc-port-listen.txt
      pc-port-established.txt
      pc-processes.txt
      phone-hilog.log
      phone-hilog-filtered.log
      phone-network-hilog.log
      screenshot-01-settings.png
      screenshot-02-result.png
    TC-01/
      ...
    TC-02/
      ...
```

- 每个用例一个目录，目录名与 `TEST-PLAN.md` 的用例编号一致。
- 每轮测试一个 `ROUND-*` 目录，不覆盖历史轮次。
- 同一用例多次执行时，文件名追加 `-run2`、`-run3`，不覆盖第一次证据。
- `meta.txt` 记录：轮次、用例、执行人、开始/结束时间、两端设备、网络类型、配置摘要、执行结果。

## 2. 命名规则

| 文件 | 内容 |
| --- | --- |
| `meta.txt` | 用例元数据、时间线、结果、问题编号 |
| `payload.txt` | 工具返回原文（离线用例含 fallback/task 字段） |
| `pc-host.log` | 电脑端 DSH 宿主标准输出/错误 |
| `pc-host.stdout.log` / `pc-host.stderr.log` | 从终端启动时的宿主输出 |
| `pc-client-console.log` | 浏览器 DevTools Console（仅 Client UI） |
| `pc-port-listen.txt` | `Get-NetTCPConnection -LocalPort 3099 -State Listen` 输出 |
| `pc-port-established.txt` | `Get-NetTCPConnection -LocalPort 3099 -State Established` 输出 |
| `pc-processes.txt` | 目标命令进程查询输出 |
| `phone-hilog.log` | 手机端 hilog 原始抓取 |
| `phone-hilog-filtered.log` | 过滤后的手机端日志 |
| `phone-network-hilog.log` | 手机端网络相关 hilog（可选） |
| `screenshot-*.png` | 手机/电脑截图，文件名带步骤号 |
| `capture-*.pcapng` | 可选抓包文件 |

## 3. 电脑端采集

### 3.1 终端启动时

```powershell
<启动 DSH 的命令> 2>&1 |
  Tee-Object -FilePath TEST-LOGS\<轮次>\<用例>\pc-host.log
```

或：

```powershell
Start-Process -FilePath "<DSH 可执行文件>" -NoNewWindow `
  -RedirectStandardOutput "TEST-LOGS\<轮次>\<用例>\pc-host.stdout.log" `
  -RedirectStandardError  "TEST-LOGS\<轮次>\<用例>\pc-host.stderr.log"
```

插件日志行以 `[dsh-remote-worker]` 开头。保留原始时间和行内容，不做筛选。

### 3.2 桌面应用无终端时

- 桌面版默认不持久化普通插件日志。
- `C:\Users\<用户名>\.dsh\logs` 只有启动诊断，不含日常插件日志。
- 无法重定向时，`pc-host.log` 允许为空；在 `meta.txt` 写“宿主日志不可采”。
- 以设置页状态、工具返回原文、端口/进程证据为主。
- 浏览器 DevTools（Ctrl+Shift+I）的 Console 只保存为 `pc-client-console.log`，用于 Client UI 报错，不作为 Host 插件日志。

同时保存：

```powershell
Get-NetTCPConnection -LocalPort 3099 -State Listen |
  Out-File TEST-LOGS\<轮次>\<用例>\pc-port-listen.txt

Get-NetTCPConnection -LocalPort 3099 -State Established |
  Out-File TEST-LOGS\<轮次>\<用例>\pc-port-established.txt

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*Start-Sleep*' } |
  Out-File TEST-LOGS\<轮次>\<用例>\pc-processes.txt
```

Windows 防火墙日志可选：

```text
%SystemRoot%\System32\LogFiles\Firewall\pfirewall.log
```

## 4. 手机端采集

### 4.1 清理并抓取 DSHNode

```powershell
hdc shell hilog -r
hdc shell hilog -T DSHNode |
  Tee-Object TEST-LOGS\<轮次>\<用例>\phone-hilog.log
```

### 4.2 过滤关键字

```powershell
hdc shell hilog |
  Select-String "DSHNode|dsh-remote-worker|ERR_|remote_execute" |
  Tee-Object TEST-LOGS\<轮次>\<用例>\phone-hilog-filtered.log
```

### 4.3 拉取配置

```powershell
hdc file recv <设备上的 remote-worker.json> `
  TEST-LOGS\<轮次>\<用例>\phone-config.redacted.json
```

### 4.4 截图

- 设置 → 远程执行（token 打码）
- 工具返回原文
- 断网/飞行模式前后
- 地址变化前后
- 插件版本与安装方式

## 5. 鸿蒙日志限制

DSH 鸿蒙原生层只转发匹配以下片段的 Node 输出：

```text
cloud-github
dsh web:
MODULE_NOT_FOUND
SyntaxError
TypeError
Unhandled
FATAL
Error:
ERR_
```

因此：

- `[dsh-remote-worker] 已监听 3099`、`[dsh-remote-worker] 仅客户端` 等普通 info 行可能不会出现在 hilog。
- 错误路径通常含 `ERR_`，可被转发。
- 普通 info 缺失时，以设置页状态、工具返回原文、端口/进程证据为主证据。
- 在 `meta.txt` 写明“hilog 未捕获普通 info 行，受宿主过滤限制”。
- 不因日志缺失本身判插件失败；错误码、结果、进程/连接状态不符才判 FAIL。

## 6. 返回原文格式

`payload.txt` 保留工具返回的完整文本，不做二次编辑。示例：

```text
ERR_WORKER_OFFLINE 电脑端离线
fallback=offline_queue
onOffline=offline-queue-test
task={"command":"Write-Output \"should-not-run\"","cwd":"C:\\Users\\<user>","timeoutMs":10000}
```

若 Agent 同时输出结构化 JSON，另存为 `payload.json`，保留字段：

- `ok`
- `taskId`
- `exitCode`
- `signal`
- `timedOut`
- `aborted`
- `durationMs`
- `stdout`
- `stderr`
- `error.code`
- `error.message`
- `error.fallback`
- `error.onOffline`
- `error.task.command`
- `error.task.cwd`
- `error.task.timeoutMs`

## 7. 脱敏与归档

- token 只保留后 4 位，截图打码。
- 不保存完整 token、Cookie、私钥、完整环境变量。
- 归档前检查 `pc-*.log`、`phone-*.log`、`payload.txt`、截图。
- 每轮结束后把 `TEST-LOGS/<轮次>/` 整体保留，不覆盖。
- 失败用例的日志与问题编号在 `TEST-RECORD.md` 中互相引用。

## 8. 归档检查

- [ ] `ENV/` 完整
- [ ] 每个执行过的用例有 `meta.txt`
- [ ] 每个执行过的用例有 `payload.txt`
- [ ] 电脑端日志已保存
- [ ] 手机端日志或过滤日志已保存
- [ ] 端口/进程证据已保存
- [ ] 截图已保存且 token 已打码
- [ ] `TEST-RECORD.md` 已填问题编号与日志路径
- [ ] 日志缺失原因已写入 `meta.txt`
