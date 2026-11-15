# dsh-remote-worker 真机验证测试计划

- 适用版本：dsh-remote-worker 1.0.0
- 测试对象：鸿蒙手机端 DSH + Windows 电脑端 DSH
- 传输方式：IPv6 直连，无中继、无信令服务器、无公网穿透
- 执行方式：人工按步骤操作，不使用自动化脚本
- 准备范围：只准备测试计划、环境、记录与日志方案，不修改插件功能代码
- 配套文件：`TEST-ENV.md`、`TEST-RECORD.md`、`ISSUES.md`、`TEST-LOGS/`

## 1. 目标与边界

验证一条核心命题：

手机端（HarmonyOS）能否通过 IPv6 直连电脑端（Windows），提交任务、接收完整结果，并在异常网络条件下返回正确错误对象。

### 1.1 范围内

- 在线正常：建连、握手、提交、流式分帧、退出码、连接关闭
- 离线：不可达时 `ERR_WORKER_OFFLINE`、`fallback: "offline_queue"`、原始任务参数副本
- 超时：服务端看门狗与客户端本地计时，`ERR_TIMEOUT` 透传
- 取消：`task.cancel` 后电脑端进程被杀、连接关闭
- 安全：错误 token、空命令白名单、cwd 越界
- 连接中断：手机切后台或断网时 `ERR_CLIENT_INTERRUPTED`，不猜任务状态
- 地址变化：电脑端 IPv6 变化后，手机端更新地址并重新连上
- 临时地址：电脑端使用临时 IPv6 时，记录地址失效表现

### 1.2 范围外

- 局域网 IPv4 直连
- 中继、信令服务器、Cloudflare Tunnel、IM 通道
- 工作区二同步插件的 GitHub 队列
- 自动 DDNS、自动 DNS 重解析
- 插件功能修改、重构、性能优化

## 2. 拓扑

```text
HarmonyOS 手机 DSH
  remote_execute
        |
        | ws://[电脑全局 IPv6]:3099/ws
        | 1 连接 = 1 任务
        v
Windows 电脑 DSH
  dsh-remote-worker host
  ctx.shell 执行命令
```

两端插件版本必须一致：`1.0.0`。

## 3. 判定标准

### 3.1 结果定义

| 结果 | 定义 |
| --- | --- |
| PASS | 所有预期字段、错误码、进程与连接状态均符合；无本地替代执行 |
| FAIL | 任一预期不符、错误码错误、进程未清理、结果被猜测、超时或崩溃 |
| BLOCK | 环境不具备条件（无全局 IPv6、无法改地址、无临时地址、无法停电脑端等），且已留下阻塞证据 |

### 3.2 通用通过条件

- 工具返回文本或错误对象中的 `code`、`message`、`fallback`、`task` 字段与用例预期一致。
- 手机端不执行本地 shell；电脑端没有出现本地替代执行。
- 电脑端监听端口、进程、连接状态与用例预期一致。
- 每次执行后 `Get-NetTCPConnection -LocalPort 3099 -State Established` 最终为空。
- 失败时保留返回原文、两端截图和日志，不以口头描述代替证据。

### 3.3 严重程度

| 级别 | 定义 |
| --- | --- |
| 阻塞 | 核心链路不可用，后续用例无法执行 |
| 严重 | 错误码错误、任务状态被猜测、命令未授权却执行、进程或端口残留 |
| 一般 | 字段缺失、日志不可采、UI 文案错误、可恢复的连接问题 |
| 建议 | 不影响本次命题的改进项 |

## 4. 用例总表

| 用例 | 名称 | 覆盖路径 | 预期核心结果 |
| --- | --- | --- | --- |
| TC-00 | 环境与安装自检 | 前置 | 两端就绪；电脑端 3099 监听；手机端仅客户端 |
| TC-01 | 在线 echo 与关闭 | 在线正常 | `exit 0`，stdout 完整，连接关闭 |
| TC-02 | 流式与大输出 | 在线正常 | 70KB stdout 完整；可分帧；不截断 |
| TC-03 | 非零退出与 stderr | 在线正常 | `ERR_EXEC`；exit code 与 stderr 尾部正确 |
| TC-04 | 电脑端离线 | 离线 | `ERR_WORKER_OFFLINE`；fallback 与 task 完整 |
| TC-05 | 任务超时 | 超时 | `ERR_TIMEOUT`；电脑端进程被杀；记录触发方 |
| TC-06 | 主动取消 | 取消 | `task.cancel`；进程被杀；连接关闭 |
| TC-07 | 错误 token | 安全 | `ERR_AUTH_FAILED`；电脑端不执行命令 |
| TC-08 | 空命令白名单 | 安全 | `ERR_REJECTED`；电脑端不执行命令 |
| TC-09 | cwd 越界 | 安全 | `ERR_REJECTED`；电脑端不执行命令 |
| TC-10 | 执行中断网或切后台 | 连接中断 | `ERR_CLIENT_INTERRUPTED`；不返回猜测结果 |
| TC-11 | IPv6 地址变化 | 地址变化 | 旧地址离线；更新 peerHost 后重连成功 |
| TC-12 | 临时 IPv6 地址 | 临时地址 | 记录临时地址与失效表现，归档为风险 |
| TC-13 | 停用与端口释放 | 生命周期 | 停用插件后 3099 不再监听 |

覆盖矩阵：

| 路径 | 用例 |
| --- | --- |
| 在线正常 | TC-01、TC-02、TC-03 |
| 离线 | TC-04 |
| 超时 | TC-05 |
| 取消 | TC-06 |
| 安全 | TC-07、TC-08、TC-09 |
| 连接中断 | TC-10 |
| 地址变化 | TC-11 |
| 临时地址 | TC-12 |

## 5. 前置准备

### 5.1 两端安装检查

电脑端：

```text
DSH 插件页应出现“远程执行”
设置 → 远程执行
角色应可选择“自动 / 电脑端 / 手机端”
```

手机端：

```text
DSH 设置 → 远程执行
应看到“仅客户端”
不应看到角色下拉框
```

若手机端出现角色下拉框，判定 FAIL，记录截图与设置页状态。

### 5.2 电脑端监听与健康检查

```powershell
Get-NetTCPConnection -LocalPort 3099 -State Listen |
  Format-Table LocalAddress,LocalPort,State,OwningProcess -AutoSize

Invoke-RestMethod -Uri "http://[::1]:3099/health" | ConvertTo-Json
curl.exe -g "http://[::1]:3099/health"
```

预期：

```json
{
  "ok": true,
  "service": "dsh-remote-worker",
  "v": 1,
  "busy": 0,
  "port": 3099,
  "uptimeMs": 1234
}
```

### 5.3 防火墙与路由器

```powershell
# 查看规则
Get-NetFirewallRule -DisplayName "dsh-remote-worker 3099" -ErrorAction SilentlyContinue

# 新建规则需要管理员 PowerShell
New-NetFirewallRule `
  -DisplayName "dsh-remote-worker 3099" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 3099 `
  -Profile Any
```

路由器侧确认：

- IPv6 已开启
- 电脑获得全局 IPv6
- 路由器 IPv6 防火墙放行入站 TCP 3099 到电脑
- 记录路由器型号、固件版本、IPv6 模式（Native / DHCPv6 / PPPoE）

### 5.4 配置快照

电脑端：

```text
C:\Users\<用户名>\.dsh\remote-worker.json
```

手机端：

```text
<应用 files>/engine/home/remote-worker.json
```

或：

```text
$DSH_HOME/remote-worker.json
```

快照规则：

- token 只保留后 4 位，其余替换为 `****`
- 记录 token 长度
- 截图中的 token 必须打码
- 记录 role、port、peerHost、peerPort、allowCommands、allowCwd、connectTimeoutMs、defaultTimeoutMs、maxTaskMs、maxConcurrent、onOffline

### 5.5 统一测试参数

| 参数 | 值 |
| --- | --- |
| 电脑端口 | `3099` |
| 手机 `peerPort` | `3099` |
| `onOffline` | `offline-queue-test` |
| 手机连接超时 | `3000` |
| 默认任务超时 | `120000` |
| 命令白名单 | `*`（安全用例除外） |
| cwd 白名单 | 默认 home（安全用例除外） |
| 测试 cwd | 电脑用户 home |

## 6. 用例详情

### TC-00 环境与安装自检

**覆盖**：前置条件

**前置条件**

- 两端插件均安装
- 电脑端 DSH 已启动
- 手机与电脑均有 IPv6 地址
- 电脑端防火墙与路由器已按 5.3 配置

**操作步骤**

1. 电脑端打开 DSH 设置 → 远程执行。
2. 记录角色、端口、状态、IPv6 地址；截图。
3. 电脑端执行 5.2 的端口与健康检查命令；保存输出。
4. 手机端打开 DSH 设置 → 远程执行。
5. 记录页面是否显示“仅客户端”，是否没有角色下拉框；截图。
6. 手机端填写电脑 IPv6、端口、token、离线钩子；点击“保存”。
7. 手机端回到会话，不提交任务。

**预期结果**

- 电脑端状态为“监听中”，端口 3099，IPv6 地址非空。
- 健康检查返回 `ok: true`、`service: "dsh-remote-worker"`、`v: 1`。
- 手机端只显示“仅客户端”，无角色下拉框。
- 手机端保存后无红色错误。
- 电脑端 `Get-NetTCPConnection -LocalPort 3099 -State Listen` 可见监听。

**判定**

- PASS：以上全部满足。
- FAIL：任一状态、字段或 UI 条件不符。
- BLOCK：两端无全局 IPv6、电脑端无法监听、插件未安装成功。

**失败取证**

- 两端设置页截图
- 健康检查原文
- `Get-NetTCPConnection` 原文
- 两端插件版本截图
- 配置快照（脱敏）

**恢复**

- 不改配置；进入 TC-01。

---

### TC-01 在线 echo 与连接关闭

**覆盖**：在线正常路径（建连、握手、提交、退出码、关闭）

**前置条件**

- TC-00 通过
- 电脑端 `allowCommands` 为 `*`
- 手机端 token 与电脑端一致
- 电脑端 `cwd` 白名单包含测试 cwd

**操作步骤**

1. 手机端打开目标会话。
2. 发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Write-Output "hello"
   cwd: <电脑用户 home>
   timeoutMs: 10000
   把工具返回原文贴出来。
   ```
   Bash 版命令：`echo hello`
3. 等待工具返回，记录开始与结束时间。
4. 立即在电脑端执行：
   ```powershell
   Get-NetTCPConnection -LocalPort 3099 -State Established |
     Format-Table LocalAddress,LocalPort,RemoteAddress,RemotePort,State -AutoSize
   ```
5. 再等待 2 秒重复第 4 步。

**预期结果**

工具返回文本包含：

```text
exit 0
hello
```

- 电脑端没有执行失败日志。
- 第 4 步可能短暂看到 Established；第 5 步应为空。
- 手机端工具返回后，连接关闭，不保留连接池。

**判定**

- PASS：exit 0、stdout 为 `hello`、第 5 步连接为空。
- FAIL：无返回、exit code 非 0、stdout 不符、连接残留。
- BLOCK：TC-00 阻塞。

**失败取证**

- 工具返回原文截图
- 电脑端 `Get-NetTCPConnection` 两次输出
- 电脑端宿主/插件日志（可采则采）
- 手机端截图与 hilog
- 手机端设置页 token/peerHost 脱敏截图

**恢复**

- 保持配置，进入 TC-02。

---

### TC-02 流式与大输出

**覆盖**：在线正常路径（流式分帧、seq、64KB 边界）

**前置条件**

- TC-01 通过
- 电脑端 shell 为 PowerShell 或 Bash（按 `TEST-ENV.md` 记录的实际类型选择命令）

**操作步骤**

PowerShell 版：

1. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: 1..2000 | ForEach-Object { "line $_"; Start-Sleep -Milliseconds 10 }
   cwd: <电脑用户 home>
   timeoutMs: 60000
   ```
2. 等待完成，记录耗时。
3. 检查返回文本是否包含 `line 1`、`line 1000`、`line 2000`。
4. 电脑端执行：
   ```powershell
   Get-NetTCPConnection -LocalPort 3099 -State Established
   ```
5. 再发送大输出命令：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: $s = "x" * 70000; Write-Output $s
   cwd: <电脑用户 home>
   timeoutMs: 30000
   ```
6. 检查返回的 stdout 长度是否为 70000 个 `x`，尾部是否完整。

Bash 版：

```bash
for i in $(seq 1 2000); do echo "line $i"; sleep 0.01; done
printf 'x%.0s' $(seq 1 70000); echo
```

**预期结果**

- 2000 行输出完整，首行、末行存在。
- 70KB 输出完整，不截断，不出现乱码。
- 任务结束后的 Established 连接为空。
- 若执行可选抓包，应看到多个 `task.stdout` 帧；不以 UI 增量显示为判据。

**判定**

- PASS：输出行数/长度正确、首尾完整、连接关闭。
- FAIL：截断、乱码、缺失行、70KB 输出不足。
- BLOCK：命令被电脑端 shell 拒绝，且已记录 shell 类型。

**失败取证**

- 返回原文（首尾各 20 行）
- stdout 字符数/字节数
- 电脑端进程与连接状态
- 电脑端宿主/插件日志（可采则采）
- 手机端 hilog
- 如使用抓包，保存抓包文件与过滤条件

**恢复**

- 保持配置，进入 TC-03。

---

### TC-03 非零退出与 stderr

**覆盖**：在线正常路径（退出码、stderr 尾部）

**前置条件**

- TC-01 通过
- 电脑端 `allowCommands` 为 `*`

**操作步骤**

PowerShell 版：

1. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Write-Output "out"; [Console]::Error.WriteLine("err"); exit 7
   cwd: <电脑用户 home>
   timeoutMs: 10000
   ```
2. 等待返回，记录文本。
3. 电脑端确认没有残留 `exit 7` 进程。

Bash 版：

```bash
echo out; echo err >&2; exit 7
```

**预期结果**

工具返回文本包含：

```text
ERR_EXEC 命令非零退出
exit 7
[stdout]
out
[stderr]
err
```

- 不得返回 `exit 0`。
- 若构造超长 stderr，最终只保留尾部 2048 字节。

可选扩展：

```text
command: [Console]::Error.WriteLine(("e" * 3000)); exit 1
```

**判定**

- PASS：`ERR_EXEC`、exit 7、stdout/stderr 正确、无残留进程。
- FAIL：错误码错误、exit code 被猜成 0、stderr 丢失。
- BLOCK：同 TC-01。

**失败取证**

- 返回原文
- 电脑端进程列表
- 两端日志
- 手机端截图

**恢复**

- 保持配置，进入 TC-04。

---

### TC-04 电脑端离线

**覆盖**：离线路径

**前置条件**

- TC-01 通过
- 手机端 `onOffline` 为 `offline-queue-test`
- 手机端 `peerHost` 指向电脑端
- 电脑端 DSH 插件处于启用状态

**操作步骤**

1. 在电脑端正常退出 DSH，或停用 `dsh-remote-worker` 插件，确保 3099 不再监听：
   ```powershell
   Get-NetTCPConnection -LocalPort 3099 -State Listen
   ```
   预期为空。
2. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Write-Output "should-not-run"
   cwd: <电脑用户 home>
   timeoutMs: 10000
   原样返回错误对象，不要重试。
   ```
3. 等待不超过 10 秒，记录返回原文与耗时。
4. 手机端确认没有本地执行结果。
5. 电脑端确认没有执行 `should-not-run`。

**预期结果**

工具返回文本包含：

```text
ERR_WORKER_OFFLINE 电脑端离线
fallback=offline_queue
onOffline=offline-queue-test
task={"command":"Write-Output \"should-not-run\"","cwd":"<电脑用户 home>","timeoutMs":10000}
```

- 不得返回 `exit 0`。
- 不得返回本地执行 stdout。
- 不得重试或自动切换通道。
- 连接超时上限约 3000ms；拒绝连接通常立即返回。

**判定**

- PASS：错误码、fallback、onOffline、task 三字段正确，无本地替代。
- FAIL：静默降级、错误码错误、task 副本缺失、返回成功。
- BLOCK：无法停止电脑端或无法确认端口关闭。

**失败取证**

- 手机端返回原文截图
- 电脑端端口检查输出
- 手机端设置页 peerHost/token 脱敏截图
- 两端日志
- 时间戳（开始、返回）

**恢复**

- 重新启动电脑端 DSH，确认 3099 监听，进入 TC-05。

---

### TC-05 任务超时

**覆盖**：超时路径（服务端看门狗 + 客户端本地计时）

**前置条件**

- TC-01 通过
- 电脑端 `allowCommands` 为 `*`
- 电脑端 shell 可执行 `Start-Sleep` 或 `sleep`

**操作步骤**

1. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Start-Sleep -Seconds 30; Write-Output "done"
   cwd: <电脑用户 home>
   timeoutMs: 3000
   不要重试。
   ```
   Bash 版命令：`sleep 30; echo done`
2. 记录开始时间。
3. 观察返回时间与返回文本。
4. 电脑端立即执行：
   ```powershell
   Get-CimInstance Win32_Process |
     Where-Object {
       $_.CommandLine -like '*Start-Sleep*' -or
       $_.CommandLine -like '*sleep 30*'
     } |
     Select-Object ProcessId,Name,CommandLine
   ```
5. 等待 5 秒再次执行第 4 步。
6. 检查 Established 连接。

**预期结果**

- 返回 `ERR_TIMEOUT 执行超时`。
- 返回时间在 3 秒到 6 秒之间；通常服务端看门狗先触发。
- 客户端本地计时器在 `timeoutMs + 2000` 毫秒（约 5 秒）兜底；若服务端未杀进程，返回时间会接近 5 秒。
- 第 5 步电脑端没有 `Start-Sleep` 或 `sleep 30` 进程。
- 不返回 `done`，不返回 `exit 0`。
- Established 连接为空。

**判定**

- PASS：`ERR_TIMEOUT`、进程被杀、连接关闭；记录“服务端看门狗”或“客户端本地计时”触发方。
- FAIL：返回成功、进程残留、错误码错误、未在预期时间内返回。
- BLOCK：shell 无法执行睡眠命令。

**失败取证**

- 开始/返回时间戳
- 手机端返回原文
- 第 4、5 步进程列表
- 连接状态
- 两端日志
- 若返回接近 5 秒，标注为客户端本地计时兜底

**恢复**

- 确认无残留进程；进入 TC-06。

---

### TC-06 主动取消

**覆盖**：取消路径（task.cancel、进程组杀、连接关闭）

**前置条件**

- TC-01 通过
- 电脑端 `allowCommands` 为 `*`
- 手机端 DSH 会话正在运行工具

**操作步骤**

1. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Start-Sleep -Seconds 60; Write-Output "done"
   cwd: <电脑用户 home>
   timeoutMs: 120000
   ```
   Bash 版命令：`sleep 60; echo done`
2. 等待 2 秒，确认电脑端出现目标进程：
   ```powershell
   Get-CimInstance Win32_Process |
     Where-Object {
       $_.CommandLine -like '*Start-Sleep*' -or
       $_.CommandLine -like '*sleep 60*'
     } |
     Select-Object ProcessId,Name,CommandLine
   ```
3. 在手机端点击会话的停止按钮，或按 Esc，终止当前 Agent 工具执行。
4. 等待 5 秒，记录手机端返回。
5. 电脑端再次执行第 2 步的进程查询；执行连接查询。
6. 记录手机端是否显示取消或中断。

**预期结果**

- 电脑端目标进程在 5 秒内消失。
- 手机端返回 `ERR_CLIENT_INTERRUPTED`（文本可能为“已取消”或“执行中断”）。
- 不返回 `done`，不返回 `exit 0`。
- Established 连接在 5 秒内消失。
- 电脑端日志应出现取消相关行为（若日志可采）。

**判定**

- PASS：进程被杀、连接关闭、错误为 `ERR_CLIENT_INTERRUPTED`、无猜测结果。
- FAIL：进程残留、连接残留、返回成功、错误码错误。
- BLOCK：手机端无法在工具执行中触发停止。

**失败取证**

- 停止前后手机端截图
- 电脑端两次进程列表
- 连接状态
- 手机端返回原文
- 两端日志
- `task.cancel` 无法直接抓帧时，以进程和连接证据替代

**恢复**

- 确认进程与连接清理；进入 TC-07。

---

### TC-07 错误 token

**覆盖**：安全路径（握手鉴权）

**前置条件**

- TC-01 通过
- 电脑端 token 已知
- 手机端可修改 token

**操作步骤**

1. 记录电脑端 token 后 4 位与长度。
2. 手机端设置 → 远程执行 → 将 token 改为错误值（保留长度接近，末位不同）。
3. 点击“保存”。
4. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Write-Output "should-not-run"
   cwd: <电脑用户 home>
   timeoutMs: 10000
   ```
5. 记录返回。
6. 电脑端确认没有 `should-not-run` 输出或相关进程。
7. 恢复手机端正确 token，保存。

**预期结果**

- 返回 `ERR_AUTH_FAILED token 错误`。
- 电脑端不执行命令。
- 连接在握手阶段关闭。
- 不返回 `exit 0`，不重试。

**判定**

- PASS：错误码正确、无命令执行、连接关闭。
- FAIL：命令被执行、错误码错误、返回成功。
- BLOCK：无法修改手机端 token。

**失败取证**

- 手机端设置页 token 脱敏截图
- 返回原文
- 电脑端进程/输出检查
- 两端日志
- 恢复后的正确 token 连接成功截图

**恢复**

- 手机端 token 恢复为电脑端值，保存。
- 进入 TC-08。

---

### TC-08 空命令白名单

**覆盖**：安全路径（命令白名单）

**前置条件**

- TC-01 通过
- 电脑端可编辑“命令”白名单
- 电脑端 `allowCwd` 可保持默认 home

**操作步骤**

1. 电脑端设置 → 远程执行 → 命令白名单。
2. 清空全部行，点击“保存”。
3. 确认保存后无“重启生效”提示（命令白名单为热更新）。
4. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Write-Output "should-not-run"
   cwd: <电脑用户 home>
   timeoutMs: 10000
   ```
5. 记录返回。
6. 电脑端确认没有执行 `should-not-run`。
7. 恢复命令白名单为 `*` 或测试命令，保存。

**预期结果**

- 返回 `ERR_REJECTED 命令未授权`。
- 电脑端不执行命令。
- 连接关闭。
- 不返回 `exit 0`。

**判定**

- PASS：`ERR_REJECTED`、无执行、连接关闭。
- FAIL：命令被执行、错误码错误、白名单保存未生效。
- BLOCK：无法编辑电脑端白名单。

**失败取证**

- 电脑端设置页白名单为空截图
- 手机端返回原文
- 电脑端进程检查
- 两端日志
- 恢复白名单后的成功对照

**恢复**

- 命令白名单恢复为 `*`。
- 进入 TC-09。

---

### TC-09 cwd 越界

**覆盖**：安全路径（cwd 白名单）

**前置条件**

- TC-01 通过
- 电脑端 `allowCwd` 为默认 home
- 电脑端 `allowCommands` 为 `*`

**操作步骤**

1. 记录电脑端 home：
   ```powershell
   $HOME
   ```
2. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Write-Output "should-not-run"
   cwd: C:\Windows
   timeoutMs: 10000
   ```
3. 记录返回。
4. 电脑端确认没有执行 `should-not-run`。
5. 可选：将 `cwd` 改为 home 子目录，重复一次，预期成功。

**预期结果**

- 越界 cwd 返回 `ERR_REJECTED 目录未授权`。
- 电脑端不执行命令。
- 连接关闭。
- home 子目录请求可成功（若目录存在）。

**判定**

- PASS：越界 `ERR_REJECTED`、无执行；子目录成功。
- FAIL：越界执行、错误码错误、home 子目录被误拒。
- BLOCK：无法设置测试 cwd。

**失败取证**

- 手机端返回原文
- 电脑端 home 与 cwd 路径截图
- 电脑端进程检查
- 两端日志

**恢复**

- 保持默认 cwd 白名单；进入 TC-10。

---

### TC-10 执行中断网或切后台

**覆盖**：连接中断路径

**前置条件**

- TC-01 通过
- 手机端可开启飞行模式或切后台
- 电脑端 `allowCommands` 为 `*`

**操作步骤**

1. 手机端发送：
   ```text
   必须调用 remote_execute，禁止使用本地 shell。
   command: Start-Sleep -Seconds 60; Write-Output "done"
   cwd: <电脑用户 home>
   timeoutMs: 120000
   ```
   Bash 版命令：`sleep 60; echo done`
2. 等待 2 秒，确认电脑端进程存在。
3. 手机端开启飞行模式，保持 10 秒；或把 DSH 切到后台并锁屏 10 秒。
4. 恢复网络或回到前台。
5. 等待工具返回，最长等待 40 秒，记录返回时间。
6. 电脑端检查进程与连接；若进程在 30 秒后仍在，记录为问题。
7. 记录手机端是否返回 `ERR_CLIENT_INTERRUPTED`，是否出现猜测的 exit code/stdout。

**预期结果**

- 返回 `ERR_CLIENT_INTERRUPTED`（文本可能为“执行中断”）。
- 不返回 `done`，不返回 `exit 0`，不猜测任务结果。
- 电脑端进程最终被杀；最迟在服务端 30 秒空闲超时后。
- Established 连接最终为空。

**判定**

- PASS：`ERR_CLIENT_INTERRUPTED`、无猜测结果、进程/连接最终清理。
- FAIL：返回成功、返回猜测结果、进程长期残留、错误码错误。
- BLOCK：手机端无法断网或无法复现。

**失败取证**

- 手机端断网/后台前后截图
- 返回原文
- 电脑端进程与连接时间线
- 两端日志
- 手机系统网络日志（若能取到）

**恢复**

- 关闭飞行模式，恢复 Wi-Fi/蜂窝；确认电脑端无残留进程。
- 进入 TC-11。

---

### TC-11 IPv6 地址变化

**覆盖**：地址变化路径

**前置条件**

- TC-01 通过
- 电脑端可获得全局 IPv6
- 可重启电脑端网络适配器或路由器，使地址变化
- 手机端可编辑 `peerHost`

**重要说明**

本插件只接受 IPv6 字面量，不做 DNS/DDNS 自动重解析。本用例的“重新解析”指人工把手机端 `peerHost` 更新为新地址。若验收要求自动重解析，本用例判 BLOCK，并在 `ISSUES.md` 记录功能缺口。

**操作步骤**

1. 记录电脑端旧地址：
   ```powershell
   Get-NetIPAddress -AddressFamily IPv6 |
     Where-Object { $_.PrefixOrigin -ne 'WellKnown' } |
     Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SuffixOrigin,AddressState,ValidLifetime,PreferredLifetime
   ```
2. 记录手机端当前 `peerHost`。
3. 让电脑端地址变化：禁用再启用网络适配器，或重启路由器/重新拨号，等待新全局 IPv6。
4. 记录新地址；确认旧地址是否消失。
5. 手机端保持旧 `peerHost`，发送 TC-01 的 echo 任务。
6. 若旧地址已消失，预期 `ERR_WORKER_OFFLINE`；若旧地址仍为 Deprecated 且仍可连，记录“旧地址未完全失效”，继续。
7. 手机端设置 → 远程执行 → 把 `电脑 IPv6` 改为新地址 → 保存。
8. 再次发送 TC-01 的 echo 任务。
9. 记录成功结果与耗时。

**预期结果**

- 旧地址行为如实记录。
- 第 7 步保存成功。
- 第 8 步：`exit 0`、stdout `hello`。
- 连接关闭。

**判定**

- PASS：新地址更新后重连成功；旧地址行为已如实记录。
- FAIL：新地址更新后仍无法连接、地址变化后插件挂起、出现本地替代执行。
- BLOCK：电脑端地址无法变化，或验收要求自动重解析（记录功能缺口）。

**失败取证**

- 旧/新地址命令输出
- 手机端 peerHost 脱敏截图
- 第 5、8 步返回原文
- 两端日志
- 时间线（地址变化时刻、重连时刻）

**恢复**

- 手机端与电脑端恢复到可用地址；进入 TC-12。

---

### TC-12 临时 IPv6 地址

**覆盖**：临时地址场景

**前置条件**

- TC-01 通过
- 电脑端存在临时 IPv6 地址；或可让系统生成临时地址

**识别命令**

```powershell
Get-NetIPAddress -AddressFamily IPv6 |
  Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SuffixOrigin,AddressState,ValidLifetime,PreferredLifetime
```

`SuffixOrigin` 为 `Random` 的全局地址按临时地址处理。若没有此类地址，本用例判 BLOCK，并记录“本环境无临时地址”。

**操作步骤**

1. 记录所有全局 IPv6，标注临时地址、有效/首选生存期。
2. 手机端把 `peerHost` 设为临时地址，保存。
3. 发送 TC-01 的 echo 任务；记录是否成功。
4. 等待临时地址到期，或让网络重新生成地址；记录旧临时地址消失时刻。
5. 保持手机端旧 `peerHost`，再次发送 echo 任务。
6. 记录错误码、耗时、是否挂起。
7. 把 `peerHost` 更新为新的稳定地址，发送 echo 任务；记录是否恢复。
8. 归档临时地址风险描述。

**预期结果**

- 临时地址有效期内可连接，或记录连接失败。
- 地址失效后返回 `ERR_WORKER_OFFLINE`，不挂起、不本地替代。
- 更新为稳定地址后可恢复连接。
- 记录临时地址未被插件过滤的事实。

**判定**

- PASS：记录了临时地址识别、失效时间、错误表现与恢复方式。
- FAIL：地址失效后挂起、返回成功、猜测结果。
- BLOCK：电脑端无临时地址；记录为环境阻塞，不改代码。

**失败取证**

- 临时/稳定地址命令输出
- 地址生命周期截图
- 手机端返回原文
- 两端日志
- 时间线
- 电脑端地址变化截图

**恢复**

- 手机端 peerHost 改为稳定地址；进入 TC-13。

---

### TC-13 停用与端口释放

**覆盖**：生命周期

**前置条件**

- TC-01 通过
- 电脑端插件已启用

**操作步骤**

1. 记录 3099 监听状态。
2. 在电脑端 DSH 插件页停用 `dsh-remote-worker`，或退出 DSH。
3. 等待 3 秒。
4. 检查：
   ```powershell
   Get-NetTCPConnection -LocalPort 3099 -State Listen
   Get-NetTCPConnection -LocalPort 3099 -State Established
   ```
5. 重新启用插件或重启 DSH。
6. 检查 3099 重新监听；执行 TC-01 echo。

**预期结果**

- 停用后 3099 无 Listen、无 Established。
- 无残留插件连接。
- 重新启用后 3099 恢复监听，echo 成功。

**判定**

- PASS：端口释放、无残留、重新启用成功。
- FAIL：端口残留、连接残留、重新启用失败。
- BLOCK：无法停用或重启插件。

**失败取证**

- 停用前后端口输出
- 插件页截图
- 重新启用后的健康检查
- 两端日志

**恢复**

- 保持插件启用，清理测试配置。

## 7. 日志采集方案

每个用例执行结束后立即把两端日志、截图、返回原文复制到：

```text
TEST-LOGS/<轮次>/<用例编号>/
```

不要等全部用例跑完再归档，避免时间线混淆。

### 7.1 电脑端

采集目标：

- 插件日志：以 `[dsh-remote-worker]` 开头的行
- DSH 宿主标准输出/错误
- 端口、进程、连接状态
- Windows 防火墙日志（可选）
- DSH 会话中的工具返回原文

采集方式：

1. 若从终端启动 DSH，重定向标准输出/错误：
   ```powershell
   <启动命令> 2>&1 | Tee-Object -FilePath TEST-LOGS\<轮次>\<用例>\pc-host.log
   ```
   或：
   ```powershell
   Start-Process -FilePath "<DSH 可执行文件>" -NoNewWindow `
     -RedirectStandardOutput "TEST-LOGS\<轮次>\<用例>\pc-host.stdout.log" `
     -RedirectStandardError  "TEST-LOGS\<轮次>\<用例>\pc-host.stderr.log"
   ```
2. 桌面版默认不持久化普通插件日志；`C:\Users\<用户名>\.dsh\logs` 只有启动诊断，不含日常插件日志。无法重定向时，`pc-host.log` 允许为空，并在 `meta.txt` 写“宿主日志不可采”；以设置页状态、工具返回原文、端口/进程证据为主。`Start-Process` 的重定向路径使用绝对路径。
3. 浏览器 DevTools（Ctrl+Shift+I）→ Console 仅用于 Client UI 报错，保存为 `pc-client-console.log`；它不等于 Host 插件日志。
4. 插件设置页状态、错误红字、端口/IPv6 地址截图。
5. 端口与进程证据：
   ```powershell
   Get-NetTCPConnection -LocalPort 3099 -State Listen |
     Out-File TEST-LOGS\<轮次>\<用例>\pc-port-listen.txt
   Get-NetTCPConnection -LocalPort 3099 -State Established |
     Out-File TEST-LOGS\<轮次>\<用例>\pc-port-established.txt
   Get-CimInstance Win32_Process |
     Where-Object { $_.CommandLine -like '*Start-Sleep*' } |
     Out-File TEST-LOGS\<轮次>\<用例>\pc-processes.txt
   ```
6. Windows 防火墙日志（若已开启）：
   ```text
   %SystemRoot%\System32\LogFiles\Firewall\pfirewall.log
   ```

格式：UTF-8 文本；每行保留原始时间戳；不截断错误码。

### 7.2 手机端

采集目标：

- 插件日志
- DSH 宿主输出
- 鸿蒙系统网络日志（若能取到）
- 工具返回原文与设置页截图

采集方式：

```powershell
# 清空并抓取 DSHNode 标签；DSH 原生层使用 LOG_TAG "DSHNode"
hdc shell hilog -r
hdc shell hilog -T DSHNode | Tee-Object TEST-LOGS\<轮次>\<用例>\phone-hilog.log

# 备选：抓全量后过滤
hdc shell hilog | Select-String "DSHNode|dsh-remote-worker|ERR_|remote_execute" |
  Tee-Object TEST-LOGS\<轮次>\<用例>\phone-hilog-filtered.log

# 网络相关日志（可选）
hdc shell hilog | Select-String "net|socket|IPv6|connect" |
  Tee-Object TEST-LOGS\<轮次>\<用例>\phone-network-hilog.log
```

配置拉取：

```powershell
hdc file recv <设备上的 remote-worker.json> TEST-LOGS\<轮次>\<用例>\phone-config.redacted.json
```

截图：

- 设置 → 远程执行（token 打码）
- 工具返回原文
- 断网/飞行模式前后
- 地址变化前后

格式：UTF-8 文本；截图 PNG；每张截图文件名带用例编号与步骤号。

### 7.3 鸿蒙日志过滤限制

DSH 鸿蒙原生层只把匹配以下片段的 Node 输出转发到 hilog：

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

因此以 `[dsh-remote-worker]` 开头的普通 info 日志可能不会出现在 hilog。出现这种情况时：

- 以设置页状态截图、工具返回原文、端口/进程证据为主证据。
- 在记录中写“hilog 未捕获普通 info 行，受宿主过滤限制”。
- 不把日志缺失本身判为插件失败；只有错误码、结果、进程状态不符才判 FAIL。

## 8. 已知风险与限制

| 编号 | 风险 | 对测试的影响 | 处理 |
| --- | --- | --- | --- |
| R-01 | 插件只接受 IPv6 字面量，无 DNS/DDNS 自动重解析 | 地址变化需人工更新 `peerHost` | TC-11 按人工更新验证；若验收要求自动，判 BLOCK 并记问题 |
| R-02 | 电脑端可能上报临时 IPv6，插件不过滤 | 地址到期后连接失败 | TC-12 记录失效表现，归档为已知风险 |
| R-03 | 鸿蒙原生日志只转发特定关键字 | 插件 info 日志可能缺失 | 用设置页/返回原文/端口证据补齐；见 7.3 |
| R-04 | `remote_execute` 在 UI 中只展示最终结果，不展示逐帧输出 | 无法直接肉眼观察流式分帧 | 用 70KB 输出完整性、耗时和可选抓包验证；帧级证据以自测和抓包为准 |
| R-05 | 工具层把离线错误转为 `ok:false` 结构对象，协议层 `dispatchTask` 才抛出 | 需核对返回对象而不是 `isError` 标志 | 记录 `error.code`、`fallback`、`task`；若验收要求工具层直接抛错，判 FAIL 并记问题，测试阶段不改代码 |
| R-06 | 主动取消在客户端表现为 `ERR_CLIENT_INTERRUPTED` | 没有单独的取消错误码 | TC-06 按 `ERR_CLIENT_INTERRUPTED` 判定 |
| R-07 | 客户端本地计时器通常晚于服务端看门狗 | 单次用例难以分别触发两个计时器 | TC-05 记录触发方；服务端正常时看门狗先触发 |

## 9. 执行顺序与恢复

建议顺序：

```text
TC-00 → TC-01 → TC-02 → TC-03 → TC-07 → TC-08 → TC-09
→ TC-05 → TC-06 → TC-04 → TC-10 → TC-11 → TC-12 → TC-13
```

恢复规则：

- 每个安全用例结束后立即恢复 token、命令白名单、cwd 白名单。
- 每个断网/取消/超时用例结束后确认无残留进程。
- 每个地址用例结束后把 `peerHost` 恢复到稳定地址。
- 每轮测试结束保留 `TEST-LOGS/<轮次>/`，不覆盖历史轮次。
- 测试期间不改插件代码；发现代码问题只写入 `ISSUES.md`。

## 10. 交付检查

- [x] 覆盖 8 条路径，每条至少一个用例
- [x] 每个用例有前置条件、操作步骤、预期结果、判定标准
- [x] 每个用例有失败取证要求
- [x] 环境模板包含 IPv6、防火墙、版本
- [x] 记录模板支持用例 → 结果 → 日志 → 问题追溯
- [x] 日志目录说明与采集方案
- [x] 问题清单模板只有表头
- [x] 不包含自动化代码
