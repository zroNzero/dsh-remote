# dsh-remote-worker

手机端 DSH 的重任务经 IPv6 直连电脑端 DSH 执行，stdout/stderr 流式回传。

- 零第三方依赖，`dependencies` 为空。
- 零原生模块。
- 运行时零 `spawn`；电脑端命令交给 DSH 已有 `ctx.shell`。
- 手写 RFC6455 最小子集。
- 手机端离线即报 `ERR_WORKER_OFFLINE`，不降级、不本地替代。
- QQ 官方机器人通道只做触发，不发 QQ 消息；结果写入 `$DSH_HOME/storages/dsh-remote-worker/results/`。

## 文件

```text
index.js                 Host 入口：角色、能力、监听、工具、Prompt、HTTP API
client.js                Web UI：设置页 settings.section
core/config.js           配置读写 ~/.dsh/remote-worker.json
core/capabilities.js     能力探测与角色解析
core/platform.js         HarmonyOS/Android 引擎路径判断
core/ipv6.js             IPv6 地址、方括号 URL、绑定探测
core/ws.js               RFC6455 握手、掩码、半包、close
core/framer.js           64KB / 50ms 流式分帧
core/server.js           IPv6 监听、健康检查、任务执行
core/client.js           1:1 连接、错误码、seq 拼接
core/executor.js         ctx.shell 适配器
core/whitelist.js        命令与 cwd 白名单
core/protocol.js         协议版本与任务校验
core/errors.js           错误码与错误对象
core/local-runner.js     本机执行适配（QQ /exec 复用）
core/qq/errors.js        QQ 错误类型
core/qq/http.js          QQ HTTP JSON 请求
core/qq/auth.js          QQ access_token 与 /gateway
core/qq/gateway.js       WSS 生命周期、心跳、重连、Resume
core/qq/protocol.js      OpCode、Identify、C2C 事件解析
core/qq/channel.js       QQ 事件队列、白名单、两种模式
core/qq/result-sink.js   $DSH_HOME/storages 明文结果写入与电脑端清理
core/qq/consumed.js      手机消费回执（storages/consumed.json）
core/sync-reader.js      手机端扫描、分页、去重、清理、followup、sync_read_result
scripts/probe.js         环境探针
scripts/selftest.js      IPv6 远程执行自测
scripts/qq-selftest.js   QQ 协议与结果写入自测
probe-result.json        本机探针实测结果
cordis.patch.yml         DSH bundle patch
locale/*.json            插件元数据
icon.svg                 插件图标
```

## 鸿蒙版契约

已按 `D:\PC\dsh\dsh-mobile` 的实际运行时实现：

- `harmony-app/entry/src/main/resources/rawfile/runtime-js.tar.gz` 内的 `@deepseek-ai/dsh-tools` 为 `0.2.2-rc.1`。
- `cloud-github.mjs` 使用 `apply(ctx, config)`、`ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.inject(['webServer'])`。
- `harmony-app/entry/src/main/cpp/napi_init.cpp` 在启动时写入 patch，禁用 `tool-bash`、`tool-pwsh`、`tool-jobs`、`tool-fs` 等本地工具行。
- 移动端仍可能加载 `dsh-bash-sandbox`，所以 `ctx.shell` 可能存在；本插件按引擎路径判定手机端，强制 `canSpawn=false`，不触发 seccomp。
- 工具注册使用普通对象，不静态 import DSH 包；手机端 profile 的 `node_modules` 只含插件包，静态 import 会解析失败。

## 安装

### 电脑端

DSH 桌面版：

```text
plugin_manager install_bundle  D:\PC\dsh\dsh-remote
```

或在 profile 中把本包加入 `dsh.profile.bundles`。

首次以 host 角色启动会生成 token，写入 `$DSH_HOME/remote-worker.json`。

### 手机端

鸿蒙版 DSH 内置 `gh_install_plugin`：

```text
gh_install_plugin  <owner>/dsh-remote-worker
```

或手动：

```text
$DSH_HOME/profiles/web/node_modules/dsh-remote-worker/
```

并在 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 加入 `dsh-remote-worker`。重启引擎生效。

手机端不显示角色选择器，设置页显示「仅客户端」。角色字段仍可写配置文件，显式 host 会抛 `ERR_ROLE_UNSUPPORTED`。

## 配置

路径：`$DSH_HOME/remote-worker.json`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `role` | `auto` | `auto` / `host` / `client`；重启生效 |
| `port` | `3099` | 电脑端监听端口；重启生效 |
| `token` | 首次生成 | 两端一致 |
| `peerHost` | 空 | 电脑端 IPv6 地址，不带方括号 |
| `peerPort` | `3099` | 电脑端端口 |
| `workerName` | 主机名 | 设备标识 |
| `allowCommands` | `[]` | 空数组拒绝全部；`*` 全放行；支持 `*`、`?` |
| `allowCwd` | `[home]` | 默认仅用户 home；子目录放行，符号链接先 realpath |
| `connectTimeoutMs` | `3000` | 连接超时；超时即 `ERR_WORKER_OFFLINE` |
| `defaultTimeoutMs` | `120000` | 默认任务超时 |
| `maxTaskMs` | `3600000` | 任务超时上限 |
| `maxConcurrent` | `1` | 并发任务数；超出回 `ERR_REJECTED` |
| `onOffline` | 空 | 离线时原样带回错误对象的字符串，不执行 |

设置页只编辑 role、QQ 通道、命令白名单、目录白名单。role 保存后提示「重启生效」。
token、peerHost、peerPort、onOffline 不在设置页编辑，仍保留在配置文件中并原样保存；IPv6 直连相关界面已移除，`/api/token` 等接口保留。

QQ 通道配置在设置页「QQ 通道」卡片，仅电脑端可见。配置保存后即时重启 QQ WSS，不需要重启 DSH。AppSecret 与 token 一样明文保存在本机配置文件，日志和状态接口不回显 AppSecret。

## 角色与能力位

| 能力位 | 电脑端 | 手机端 |
| --- | --- | --- |
| `canServe` | true，`ctx.shell` 存在且 `::` 可绑定 | false |
| `canDispatch` | true | true |
| `canSpawn` | true | false |

`canServe` 是设备能力；`serveEnabled = role==='host' && canServe` 才监听。代码内部按 `serveEnabled`、`canDispatch`、`canSpawn` 判断，role 只用于 UI 与启动校验。

- `host` 需要 `canServe=true`，否则 `activate` 抛 `ERR_ROLE_UNSUPPORTED`。
- `client` 需要 `canDispatch=true`。
- `auto`：`canServe` 为真取 host，否则 client。
- 手机端 `ctx.shell` 即使存在也不参与执行；命令只走 IPv6 到电脑端。

## System Prompt

仅 `canDispatch` 实例注入：

```text
重任务（编译/构建/装依赖/长脚本）必须调 remote_execute。
禁止本地静默替代。失败即上报，不得降级。
ERR_WORKER_OFFLINE → 告知“电脑端离线”，不重试。
ERR_TIMEOUT → 最多重试 1 次，加大 timeoutMs 并说明。
stderr 原样转述关键行，不扩写。
```

## IPv6

电脑端优先监听 `::`：

```js
server.listen({ host: '::', port, ipv6Only: false })
```

Linux `bindv6only=0` 时 `::` 同时覆盖 IPv6 与 IPv4-mapped；Windows 默认双栈。

客户端 URL 使用方括号：

```text
ws://[2xxx:xxxx::1]:3099/ws
```

链路本地地址带 zone id：

```text
fe80::1%8
```

插件会编码为 `[fe80::1%258]` 再连接。`peerHost` 必须是 IPv6 字面量，不做 DNS。

健康检查：

```text
GET http://[2xxx:xxxx::1]:3099/health
```

返回：

```json
{"ok":true,"service":"dsh-remote-worker","v":1,"busy":0,"port":3099,"uptimeMs":1234}
```

## 协议

单连接单任务。每次 `remote_execute` 新建 WS，握手、提交、收 `task.exit`、发 close 帧、TCP FIN。

握手：

```text
client -> hello      {type,v,device,token}
server -> welcome    {type,v,sessionId,worker}
server -> error      {type,code,message}
```

业务：

```text
client -> task.submit   {type,taskId,command,cwd,timeoutMs}
server -> task.ack      {type,taskId}
server -> task.stdout   {type,taskId,seq,data}
server -> task.stderr   {type,taskId,seq,data}
server -> task.exit     {type,taskId,exitCode,signal,timedOut,aborted,durationMs,...}
client -> task.cancel   {type,taskId}
```

- 文本帧，JSON。
- 客户端帧掩码，服务端帧不掩码。
- 只支持单帧文本；控制帧支持 close/ping/pong。
- `seq` 从 1 单调递增；客户端乱序缓存、按序拼接，缺口报 `ERR_CLIENT_INTERRUPTED`。
- 首帧立即刷；之后满 64KB 或距上次刷 50ms 刷一帧。
- 服务端 30 秒读写空闲超时，关闭半开连接。
- 客户端无心跳、无连接池、无后台保活、无断线续传。
- stderr 实时帧可能大于 2KB；最终返回给调用方的 stderr 取尾部 2048 字节。

## 错误码

| 码 | 触发 |
| --- | --- |
| `ERR_WORKER_OFFLINE` | 连接超时、拒绝、地址不可用 |
| `ERR_AUTH_FAILED` | 握手 token 不一致 |
| `ERR_TIMEOUT` | 连接后等待超时、任务超时 |
| `ERR_REJECTED` | 并发满、命令/目录不在白名单、协议拒绝 |
| `ERR_EXEC` | 命令非零退出、信号退出、执行器失败 |
| `ERR_ROLE_UNSUPPORTED` | 本机能力不支持所选角色 |
| `ERR_PORT_IN_USE` | 监听端口被占用；不重试，设置页红字 |
| `ERR_CLIENT_INTERRUPTED` | 执行期间连接中断，不猜任务结果 |

错误文案单条不超过 15 字。

## 与工作区二衔接

`remote_execute` 在离线时返回：

```json
{
  "ok": false,
  "error": {
    "code": "ERR_WORKER_OFFLINE",
    "message": "电脑端离线",
    "fallback": "offline_queue",
    "onOffline": "用户配置的钩子标识",
    "task": {
      "command": "pnpm build",
      "cwd": "",
      "timeoutMs": 120000
    }
  }
}
```

`dispatchTask` 在同一条件下抛出 `RemoteWorkerError`，字段与上表一致；`remote_execute` 捕获后返回同构 error 对象，Agent 直接读：

```js
import { dispatchTask, ERROR_CODES } from 'dsh-remote-worker'
```

上层编排逻辑读到 `fallback: "offline_queue"` 后，自行决定是否转入工作区二的 GitHub 队列。

本插件不调用 `onOffline`，不直接写 GitHub，不读写同步队列。QQ 结果只写入 `$DSH_HOME/storages/`，由 one-sync 扫描并推送。

## QQ 官方机器人通道

### 链路

```text
手机 QQ 私聊机器人
  -> 官方 WSS 网关
  -> C2C_MESSAGE_CREATE
  -> 本机执行层（/exec）或 DSH 会话 prompt（自然语言）
  -> 结果 JSON 写入 $DSH_HOME/storages/dsh-remote-worker/results/
  -> 用户在手机端点同步，看到结果
```

QQ 只负责触发，不负责回传。插件没有调用任何 QQ 发消息接口；WSS 上只发送 Identify、Resume、Heartbeat 等协议帧。

### 官方 API

- access_token：`POST https://bots.qq.com/app/getAppAccessToken`
- 网关：`GET https://api.bot.qq.com/gateway`
- WSS：网关返回的 `wss://.../websocket/` 地址
- intents：`GROUP_AND_C2C_EVENT`（`1 << 25`）
- shard：`[0, 1]`
- 心跳：OpCode 1，服务端 OpCode 11 确认
- 鉴权：OpCode 2 Identify，token 为 `QQBot <access_token>`
- 重连：优先 OpCode 6 Resume；失败回退 Identify
- token 缓存到过期前 60 秒；重连或刷新时重新获取

### 配置

`$DSH_HOME/remote-worker.json` 的 `qq` 对象：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `qq.enabled` | `false` | 启用 QQ 通道 |
| `qq.appId` | 空 | 官方机器人 AppID |
| `qq.appSecret` | 空 | 官方机器人 AppSecret |
| `qq.apiBase` | `https://api.bot.qq.com` | 网关 API 根 |
| `qq.tokenUrl` | `https://bots.qq.com/app/getAppAccessToken` | token 地址 |
| `qq.intents` | `33554432` | GROUP_AND_C2C_EVENT |
| `qq.shard` | `[0,1]` | 不分片 |
| `qq.whitelist` | `[]` | 允许的发送者 openid；空数组放行全部 |
| `qq.mode` | `natural` | `natural` 自然语言 / `exec` 前缀指令 |
| `qq.prefix` | `/exec` | exec 模式前缀 |
| `qq.sessionId` | 空 | 自然语言目标会话；空则按 `qq.cwd` 或空闲会话 |
| `qq.cwd` | 空 | 工作区：natural 专用会话目录；exec 默认目录；空则 home |
| `qq.timeoutMs` | `120000` | QQ 任务超时 |
| `qq.maxQueue` | `8` | 事件队列上限；超出写 `rejected` 结果，不静默丢 |
| `qq.resume` | `true` | 断线优先 Resume |
| `qq.retentionKeep` | `200` | 电脑端保留结果条数 |
| `qq.retentionMinAgeMs` | `3600000` | 清理保护期，1 小时 |
| `qq.cleanupIntervalMs` | `3600000` | 清理周期，1 小时 |

### 两种模式

- `natural`：消息文本作为 user prompt 注入电脑端已有 DSH Agent 会话，Agent 自行决定调用哪些工具；最终 assistant 文本作为结果 `stdout`。
- `exec`：只处理以 `prefix` 开头的消息，去掉前缀后交给 `ctx.shell`；复用 `allowCommands` 与 `allowCwd` 校验。

自然语言模式的目标会话，按优先级：

1. `qq.sessionId` 有值：使用该会话。
   - 在线：`agents.get` 直接取。
   - 不在线：`agents.resume({ resumeSessionId })` 恢复。
   - 恢复失败：记录 `lastError`，继续走第 2 条。
2. `qq.cwd` 有值：使用绑定该目录的 QQ 专用会话。
   - 首次：`agents.create({ sessionId, meta: { cwd } })` 新建，sessionId 写入 `$DSH_HOME/dsh-remote-worker/qq-session.json`。
   - 重启后：先 `agents.get` 找活会话，找不到再 `agents.resume({ resumeSessionId })`，都失败才新建。
   - 创建失败但存在空闲会话：退回空闲会话并记录 `lastError`。
3. 两者都空：优先取空闲 Agent，没有空闲则取第一个。
4. 无可用 Agent：写入 `QQ_NO_AGENT` 错误结果，不通过 QQ 回复。

### 选择工作区与对话

设置页的 QQ 卡片提供两个下拉框，数据来自 `GET /dsh-remote-worker/api/workspaces`：

- 读 `$DSH_HOME/storages/workspace.json`（只读，不写入）。
- 列出各工作区的 `title`、`path`、默认标记，以及未归档的会话。
- 会话带 `live`（当前进程是否已加载）、`createdAt`、`updatedAt`（会话文件最后修改时间）。
- 归档会话（`archivedSessionIds`）和 `origin: "subagent"` 的子会话不出现在列表里。

选择行为：

| 选择 | 写入配置 | 效果 |
| --- | --- | --- |
| 工作区 = 自动 | `cwd = ''` | 回到"挑空闲会话" |
| 工作区 = 某项 | `cwd = <path>` | QQ 消息进入该目录的专用会话 |
| 对话 = 新建专用会话 | `sessionId = ''` | 使用上面 `cwd` 的专用会话 |
| 对话 = 某个会话 | `sessionId = <id>` | 注入该会话；不在线先 resume |

切换工作区会清空已选对话，避免跨工作区误注入。`sessionId` 优先级高于 `cwd`。

会话标题不可用：DSH 的 `agents` 服务只暴露 id；磁盘上的会话只有 `session.v4.jsonl.zstd`，头部含 `cwd`、`origin`、`createdAt`，不含标题。用 Node 内置 `node:zlib` 的 `zstdDecompressSync` 读头部（文件超过 2MB 跳过）以过滤 subagent 会话，不引第三方依赖。下拉框用 `id` 前 18 位 + 创建日期 + 在线标记区分。

映射到配置举例：

```json
"qq": { "cwd": "D:\\PC\\dsh", "sessionId": "session-8ef46764-…" }
```

### 结果文件

固定写入：

```text
$DSH_HOME/storages/dsh-remote-worker/results/<job-id>.json
```

电脑端实际值：

```text
C:\Users\zro_0\.dsh\storages\dsh-remote-worker\results\
```

手机端实际值：

```text
/data/storage/el2/base/haps/entry/files/engine/home/storages/dsh-remote-worker/results/
```

写入规则：

- 明文 JSON；不加密；不写 `.dshx`；不碰 stateRepo API。
- 临时文件用 `.partial` 后缀，写完 `rename` 原子落盘。
- 文件名只用 `id`，限定字母数字 `_ -`；无尾部空格或点，无 Windows 保留名。
- 已存在同名结果不覆盖；符号链接跳过或拒绝。
- 单文件不超过 45MB；超大时压缩 `stdout` 并写 `stdoutTruncated: true`、`stdoutBytes`。
- 不写 `storages/workspace.json`。

结果 JSON 字段：

```json
{
  "id": "qq-...",
  "dedupeKey": "qq:<messageId>",
  "source": "qq",
  "kind": "task-result",
  "createdAt": "2026-11-11T10:00:00.000Z",
  "instruction": "/exec pnpm build",
  "mode": "exec",
  "command": "pnpm build",
  "status": "ok",
  "exitCode": 0,
  "signal": null,
  "stdout": "...",
  "stderr": "...尾部最多 2048 字节...",
  "cwd": "D:\\project",
  "durationMs": 1234,
  "messageId": "QQ 消息 ID",
  "sender": "abcd***wxyz",
  "senderHash": "SHA-256",
  "stdoutTruncated": false
}
```

自然语言模式额外带 `prompt`、`sessionId`，`exitCode` 为 0，`stderr` 为空。失败结果带 `error: { code, message }`。

`sender` 不保存完整 QQ openid：只保留脱敏值，另存 `senderHash`（SHA-256）用于关联；白名单匹配只使用内存中的原始 openid，不落结果文件。

超大 `stdout` 写入时，文件内 `stdout` 保留尾部，另带 `stdoutTruncated: true`、`stdoutBytes`；读取时按分页参数返回。

### 清理策略

电脑端：

- 每次写入结果后、`apply()` 启动时清理一次；QQ 通道启用时每小时再清理一次。
- 只删除 `results/` 下本插件自己的文件：`id` 以 `qq-` 开头、`source=qq`、`kind=task-result`。
- 按 `createdAt` 从旧到新，最多保留 `qq.retentionKeep`（默认 200）个。
- 只有 `storages/dsh-remote-worker/consumed.json` 标记为已消费、且超过 `qq.retentionMinAgeMs`（默认 1 小时）的文件才删除。
- 未消费结果即使超过 N 也保留，避免电脑端在手机未读取前误删；这是容量可超过 N 的预期情况。
- `consumed.json` 由手机端 `sync_read_result` 完整读取后写入，经 one-sync 状态同步回到电脑端；文件本身原子写入，不参与结果目录扫描。
- 清理幂等；文件删除失败、被 one-sync 占用时跳过，下一轮再试。

手机端：

- `sync_read_result` 完整返回一个结果后写入 `consumed.json`，并把 id 标记为已读。
- 本地结果文件只删除已读、非分页中（`partialIds`）、且超过 `reader.retentionMinAgeMs`（默认 5 分钟）的文件；保留最近 `reader.retentionKeep`（默认 100）个。
- 未读结果、分页未完成结果、其他插件写入 `results/` 的文件都不删。
- 已读 id 保留在 `reader-state.json`；文件即使被删，也不会重新变成未消费。

竞态：

- 写入用 `.partial` + `rename`；清理是单文件 `unlink`，不会让 one-sync 看到半截 JSON。
- 清理只处理完整 `.json`，跳过点文件；删除前有最小年龄保护。
- 电脑端只删除手机已消费的结果，删除时手机已经完成读取。
- 手机端两个读取器实例用 `reader.lock` 串行化；状态文件损坏时从 `.bak` 恢复。
- 限制：one-sync 对“远端独有文件绝不删除”，本插件只能删本地明文结果，无法删除 stateRepo 中已加密的历史对象；这属于 one-sync 的远端保留策略，不在本插件红线内，需要 one-sync 侧处理。本地清理仍能降低电脑端/手机端的文件数与扫描量，已读 id 也不会重复消费。

### 与 one-sync 的对接方式

- one-sync 扫描整个 `storages/` 目录；本插件只把明文 JSON 放进 `storages/dsh-remote-worker/results/`。
- one-sync 电脑端按现有状态同步逻辑加密上传；手机端点同步后解密落盘到相同的 `$DSH_HOME/storages/...` 路径。
- 本插件不调用 GitHub API，不读 one-sync 配置/token/passphrase，不修改 one-sync 源码，不碰加密函数或 stateRepo API。
- 不再使用 one-sync 的 `codeDir` 写结果。

### 手机端读取

手机端 `apply()` 启动时：

- 固定扫描 `$DSH_HOME/storages/dsh-remote-worker/results/`。
- 注册 `sync_read_result` 工具。
- 可选 `agent.followup` 注入短指针；不把结果正文塞进 user message。
- 每 `reader.pollMs`（默认 5000ms）扫描一次；无 `fs.watch`；`deactivate` 清理定时器。
- 应用被杀后扫描与注入停止；重新打开 App 时 `apply()` 扫描一次，目标会话未恢复则只保留结果，不强行唤醒。

去重与消费状态：

- 状态文件：`$DSH_HOME/dsh-remote-worker/reader-state.json`（不在 `storages/` 内，不参与 one-sync 同步）。
- 手机实际：`/data/storage/el2/base/haps/entry/files/engine/home/dsh-remote-worker/reader-state.json`。
- 消费回执：`$DSH_HOME/storages/dsh-remote-worker/consumed.json`；手机实际在固定 results 同级的 `consumed.json`。
- 状态备份：`reader-state.json.bak`；主文件损坏时回退备份，并把 `consumed.json` 的 id/key 合并进已读状态。
- 多实例串行锁：`reader.lock`；锁 30 秒过期；两个读取器不会重复取同一条结果。
- 按 `id` 去重；`dedupeKey` 非空时也按 `dedupeKey` 去重。
- `readIds/readKeys`：`sync_read_result` 成功返回后写入，重启不重复读。
- `injectedIds/injectedKeys`：`followup` 成功后写入，重启不重复注入。
- `partialIds`：大 stdout 分页未完成时保留，禁止清理。
- 状态数组上限：已读/注入各 2000 条，分页 1000 条；`consumed.json` 5000 条。
- followup 失败不写状态，下一轮可重试。
- 目标 `sessionId` 记在状态文件；配置 `reader.targetSessionId` 优先。

`sync_read_result` 入参：

```json
{
  "id": "qq-...",
  "offset": 0,
  "limit": 65536
}
```

- `id` 可选；不传时取最早未读结果（`createdAt` 升序）。
- `offset` 可选，stdout 字节偏移，默认 0。
- `limit` 可选，stdout 字节数，默认 64KB，最大 256KB。
- 分页时用 `nextOffset` 作为下一次 `offset`；`id` 必须带上。

返回结构：

```json
{
  "ok": true,
  "found": true,
  "result": {
    "id": "qq-...",
    "dedupeKey": "qq:...",
    "createdAt": "2026-11-11T10:00:00.000Z",
    "source": "qq",
    "kind": "task-result",
    "instruction": "...",
    "status": "ok",
    "exitCode": 0,
    "stdout": "...本页内容...",
    "stderr": "...",
    "durationMs": 1234,
    "messageId": "...",
    "sender": "abcd***wxyz",
    "senderHash": "...",
    "truncated": true,
    "fullSize": 300000,
    "offset": 0,
    "limit": 65536,
    "nextOffset": 65536
  },
  "unread": 1,
  "consumed": true,
  "fullyConsumed": false,
  "persisted": true,
  "consumedPersisted": false,
  "alreadyRead": false
}
```

- `truncated=true` 表示还有下一页；`fullSize` 是 stdout 原始字节数。
- `fullyConsumed=false` 时文件不会被清理，`consumed.json` 也不会标记，直到分页读完。
- 小结果直接返回，`truncated=false`、`nextOffset=null`。

无未读时返回：

```json
{ "ok": true, "found": false, "unread": 0 }
```

followup 消息：

```text
有新的同步结果，调用 sync_read_result 读取（id: qq-...）
```

只唤醒，不含结果正文。触发条件：`reader.autoFollowup=true`、存在未读且未注入的新结果、能选到目标 Agent；每轮最多注入一条。

目标会话选择顺序：`reader.targetSessionId` → 状态文件记录的 sessionId → `ctx.agents.roots()` 中的空闲根会话 → `ctx.agents.list()` 第一个。无可用 Agent 时不注入，但工具仍可读；下一轮扫描再试。

鸿蒙 cloud-only 下 Agent 没有本地 read/glob/grep/bash；读取由插件进程完成，工具只返回已读文件内容。

`reader` 配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `reader.targetSessionId` | 空 | 指定唤醒的目标会话；空则自动选择并记录 |
| `reader.autoFollowup` | `true` | 扫描到新结果后是否 followup 唤醒 |
| `reader.pollMs` | `5000` | 扫描周期，1000–60000ms |
| `reader.retentionKeep` | `100` | 手机端保留结果条数 |
| `reader.retentionMinAgeMs` | `300000` | 本地清理保护期，5 分钟 |
| `reader.stdoutLimit` | `65536` | 默认单页 stdout 字节数，64KB |
| `reader.maxStdoutLimit` | `262144` | 单页上限，256KB |

### QQ 日志与状态

- 设置页显示 WSS 状态、最后错误、最后结果、队列长度。
- 状态值：`未配置`、`连接中`、`握手中`、`鉴权中`、`恢复中`、`在线`、`重连中`、`错误`、`已停用`。
- 日志不打印 AppSecret、access_token、消息正文；仅短状态。
- `deactivate` 关闭 WSS、清理心跳/重连/握手/清理定时器；等待当前任务并写入结果，超时才取消；排队未开始的消息写 `rejected` 结果，不静默丢。
- 队列满时不静默丢消息，写 `rejected` 结果。
- 同一 `dedupeKey` 的旧结果或已消费记录会阻止重启后重复执行。

### 链路审计与修复

| 缺口 | 修复 | 验证 |
| --- | --- | --- |
| 结果文件无限累积 | 电脑端/手机端按 N + 保护期清理；电脑端只删手机已消费 | `pc cleanup...`、`reader paginates...` |
| 大 stdout 撑爆上下文 | 默认 64KB 分页，`truncated/fullSize/nextOffset` | `reader paginates...` |
| deactivate 丢当前结果 | `stopGracefully` 等待当前任务，超时才取消 | `graceful stop...` |
| 队列满静默丢消息 | 写 `rejected` 结果 | `queue backpressure...` |
| 重启后重复执行 | `dedupeKey` + 结果文件/consumed 检查 | `queue/restart dedupe` |
| 两个读取器重复消费 | `reader.lock` 串行化 | `two readers` |
| `reader-state.json` 损坏 | `.bak` 恢复 + consumed 合并 | `backup state` |
| followup 目标关闭/切换 | 每轮重新解析，失败不标记，下一轮重试 | 代码审查 |
| 清理与 one-sync 扫描竞态 | `.partial`+rename、单文件 unlink、最小年龄、只删自己文件 | 清理测试 |
| 45MB 上限 | 写入时截断 stdout 并校验字节数 | `result file stays under 45MB` |
| sender 隐私 | 结果只存脱敏值 + `senderHash` | 首条结果断言 |
| 分页未完成被清理 | `partialIds` 阻止清理和消费标记 | `reader paginates...` |
| one-sync 远端历史对象 | 本插件无法删 stateRepo；只清本地明文，已在偏离记录说明 | 文档 |

### 验收要点

- 配置凭证后完成 Hello、Identify、心跳。
- 白名单外消息被忽略。
- 白名单内消息触发执行。
- 结果写入 `$DSH_HOME/storages/dsh-remote-worker/results/`。
- 电脑端/手机端按保留数清理；未消费结果不误删；不删其他插件文件。
- 手机端扫描固定目录，`sync_read_result` 可读，去重与重启不重复注入。
- 大 stdout 默认截断，`truncated/fullSize` 正确，可用 `offset/limit` 分页。
- 客户端发出的 WSS OpCode 只有 1/2/6；没有 QQ 发消息 API 调用。
- deactivate 后 WSS 关闭、定时器清理。

## 白名单

- `allowCommands: []` 拒绝全部任务。
- `allowCommands: ["*"]` 全放行。
- `allowCommands: ["pnpm *", "git *"]` 按整条命令匹配。
- `cwd` 省略时用 home。
- `allowCwd` 默认 `[home]`。
- 目标目录先 `realpath`，再判断是否在放行目录内；符号链接逃逸拒绝。
- 目录不存在拒绝。

## 探针

```powershell
node scripts/probe.js
node scripts/update-defaults.js
```

输出到 stdout，写 `probe-result.json`，再由 `update-defaults.js` 写入 `core/probe-defaults.js`。

本机实测：

- Node `v24.17.0`，`win32/x64`。
- `::` 绑定成功；`::1` 连接成功。
- 无全局 IPv6；有链路本地 `fe80::...` 与回环 `::1`。
- `net` / `dgram` / `http` / `crypto` 可用。
- `spawnSync` 在 Windows 返回 0；手机端由运行路径判定为 mobile，`canSpawn=false`。

探针默认值写入 `core/probe-defaults.js`；运行时仍现场探测，不把探针结果当唯一依据。

## 自测

```powershell
node scripts/selftest.js
```

实测：

```text
18 passed, 0 failed
```

覆盖：

- 端口占用返回 `ERR_PORT_IN_USE`。
- IPv6 健康检查。
- IPv6 WS echo，stdout 与 exit code。
- 70KB stdout 分帧与 seq。
- stderr 尾部 2KB。
- token 错误。
- 空白名单拒绝。
- cwd 越界拒绝。
- 离线错误含 fallback / onOffline / task。
- 客户端超时。
- 执行中连接中断。
- dispose 后端口释放。
- 插件 `apply` 注册 `remote_execute` 并执行。
- 离线时模型可见 `fallback=offline_queue` 与任务参数。
- 手机运行路径判定。
- 手机端 host 角色拒绝。
- 配置读写往返。

自测中的 `echo` 由进程内假 shell 执行，不 spawn 子进程；真实电脑端使用 DSH `ctx.shell`。

QQ 通道自测：

```powershell
npm run qq-test
```

实测：

```text
19 passed, 0 failed
```

覆盖：

- 本地假 QQ 网关完成 Hello、Identify、心跳。
- `/exec` 白名单内消息触发执行，结果 JSON 写入 `storages`。
- 手机端读取器去重、followup、重启不重复注入、定时器清理。
- 电脑端清理保留 N、删已消费最旧、保未读、不删其他插件文件、幂等。
- 手机端清理保留 N、保未读、分页未完成文件不删。
- closed followup 目标失败不标记注入。
- 空白名单放行所有发送者。
- 大 stdout 默认截断、分页、`truncated/fullSize`。
- `reader-state.json` 损坏从备份恢复；两个读取器串行不重复。
- 队列满写 `rejected` 结果；文件级 dedupe 重启后生效。
- `stopGracefully` 等待当前任务。
- 46MB stdout 写入后文件不超过 45MB。
- 白名单外消息忽略。
- `qq.cwd` 绑定专用会话：首次新建、复用、重启后 resume。
- 空白名单放行所有发送者。
- 工作区列表读 `workspace.json`、过滤归档、标记在线会话、目录名编码、过滤 subagent 会话。
- 指定 `sessionId`：在线直用、离线 resume、恢复失败回退工作区。
- 断线后 Resume，token 不重复获取。
- token 过期前刷新。
- 自然语言模式注入假 Agent，结果取最终 assistant 文本。
- 客户端 WSS OpCode 只有 1/2/6，无 QQ 发消息。
- stop 后 WSS 关闭、队列清空。

实际 QQ 官方网关、真实 AppID/AppSecret、真实鸿蒙手机与 one-sync 手机端拉取未联调。

## 验收对照

| 项 | 状态 |
| --- | --- |
| 文件齐全，dependencies 为空 | 是 |
| 探针可运行并输出 JSON | 是 |
| IPv6 端到端自测 | 是，`::1` |
| 手机端不出现 role 选择器 | 代码按 `canServe=false` 隐藏；未真机截图 |
| deactivate 后端口释放 | 自测通过 |
| 中断抛 `ERR_CLIENT_INTERRUPTED` | 自测通过 |
| 文案短句 | 代码检查；机器 JSON 数据行除外 |
| 空白名单拒绝全部 | 自测通过 |
| 连接任务 1:1，无池无心跳 | 是 |
| 离线错误含 fallback 与任务副本 | 自测通过 |
| QQ 配置后 Identify / 心跳 | 本地假网关通过；官方网关未联调 |
| QQ 白名单过滤 | 自测通过 |
| QQ 结果写入 storages | 自测通过；真实手机同步未验证 |
| 清理保留 N / 不误删未消费 / 不删其他插件 | 自测通过 |
| 大 stdout 截断与分页 | 自测通过 |
| 手机端 `sync_read_result` | 自测通过；真实 Agent 会话未验证 |
| 无 QQ 发消息 | 自测断言 OpCode 只有 1/2/6；源码无发消息接口 |
| README 偏离记录 | 见下 |
| 无遗留项 | 是 |

## 偏离记录

- 本机没有全局 IPv6，自测使用 `::1`；生产仍只走 IPv6，未改用 IPv4。
- Node `os.networkInterfaces()` 不暴露 Temporary 标记，无法像 `dsh-ipv6-gate` 那样排除临时地址；插件列出所有非链路本地全局地址，由用户选择。
- `scripts/probe.js` 按任务要求尝试一次 `spawnSync` 探测 seccomp；这是唯一使用 `child_process` 的文件，运行时 `index.js`/`core/*` 不 import `child_process`。
- 手机端角色选择器未在鸿蒙真机截图验证；只验证了能力位与渲染条件。
- QQ 官方 AppID/AppSecret 尚未提供，官方 WSS 网关、真实 token、真实 C2C 事件未联调；目前只通过本地假网关验证协议。
- QQ 结果写入 `$DSH_HOME/storages/dsh-remote-worker/results/`；one-sync 负责扫描、加密和 stateRepo 同步，本插件不碰加密与 stateRepo API。
- 手机端读取器使用固定 `$DSH_HOME` 路径；真实鸿蒙设备、真实 one-sync 解密落盘和真实 `agent.followup` 目标会话未验证。
- 手机端目标会话自动选择逻辑（roots → list）未在真机验证；`reader.targetSessionId` 可显式指定。
- 自然语言模式使用已有 DSH Agent 会话；真实会话选择、Agent 最终文本和工具调用未在真机验证，自测使用假 Agent。
- QQ 通道默认 `enabled: false`、白名单为空、凭证为空；未配置时不会发起网络连接。
- 已读消费通过 `consumed.json` 从手机同步回电脑端；真实 one-sync 往返、两实例锁和手机文件删除未在真机验证。
- one-sync 的远端“独有文件不删除”策略不会因本地清理而删除 stateRepo 历史对象；本插件只清本地明文，不碰 stateRepo。远端对象保留需要 one-sync 侧处理。
- 大 stdout 截断按字节分页，UTF-8 多字节边界可能产生替换字符；默认 64KB、上限 256KB。
- 未读结果和未完成分页的结果不会被清理，因此条数可能超过 N；这是为避免丢结果的预期取舍。
- 未修改、未复制 `D:\PC\dsh\dsh-one-sync` 的任何文件；one-sync 侧无建议改动。
