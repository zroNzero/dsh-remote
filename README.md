# dsh-remote-worker

把重活交给电脑跑，手机只负责发号施令和看结果。

DeepSeek Harness 插件。零第三方依赖、无原生模块、不 spawn 子进程，WebSocket 按 RFC6455 手写实现。

---

## 它能做什么

| 能力 | 在哪运行 | 怎么用 |
| --- | --- | --- |
| IPv6 直连派发命令 | 电脑当服务端，手机当客户端 | `remote_execute` 工具 |
| QQ 官方机器人通道 | 电脑 | 手机 QQ 直接发消息给机器人 |
| 结果同步到手机 | 手机 | `sync_read_result` 工具 |
| 设置面板 | 两边同款 | 设置 → 远程执行 |

典型用法：**手机 QQ 发一句"帮我编译一下"，电脑执行，结果落成文件，手机上用一条命令读出来。**

---

## 安装

### 电脑端

本地目录（软链接，改代码即生效）：

```text
plugin_manager install_bundle  link:D:/PC/dsh/dsh-remote
```

或从 GitHub 装：

```text
plugin_manager install_bundle  https://github.com/zroNzero/dsh-remote
```

### 手机端（鸿蒙 DSH）

```text
gh_install_plugin  zroNzero/dsh-remote
```

装完在「包含的组件」里应该看到 `远程执行` 且**状态正常**。

> 手机端只启用结果同步部分。IPv6 服务端和 QQ 通道需要能 spawn 进程，手机上会自动跳过，这是设计行为不是故障。

---

## 快速开始：让手机 QQ 指挥电脑

### 第 1 步：配置角色

打开 **设置 → 远程执行**，`role` 选 `host`（默认 `auto` 也会自动判断，电脑有 shell 就是 host）。

### 第 2 步：拿 QQ 机器人凭证

1. 去 [QQ 开放平台](https://q.qq.com/) 建一个机器人应用
2. 在「开发设置」里拿到 **AppID** 和 **AppSecret**
3. 确认已开通「单聊」消息权限

### 第 3 步：填进面板

| 字段 | 填什么 | 示例 |
| --- | --- | --- |
| `enabled` | 打勾 | ✓ |
| `appId` | 机器人 AppID | `1234567890` |
| `appSecret` | 机器人 AppSecret | 一长串字符 |
| `mode` | 见下表 | `natural` |
| `whitelist` | 留空 = 谁都能用 | `[]` |

保存后面板顶部的 `qq.state` 应该变成 **`ready`**，`gateway.state` 也是 `ready`。

### 第 4 步：从 QQ 发消息

用手机 QQ 给这个机器人发消息即可。

**注意：插件只接收，不向 QQ 回发消息。** 这是有意的——官方机器人要在 `msg_id` 语境里被动回复，实现成本高且容易风控。结果会写进文件，由手机端读取。

---

## QQ 通道的两种模式

| 模式 | 消息内容被当作 | 适合 |
| --- | --- | --- |
| `natural`（默认） | 一句自然语言，交给 Agent 理解并执行 | 日常「帮我把 XX 编译一下」 |
| `exec` | 一条命令，必须以 `/exec ` 开头，直接执行 | 精确控制，不需要 Agent 参与 |

`exec` 模式举例：

```text
/exec npm run build
```

不以 `/exec ` 开头的消息会被忽略。

---

## 选择在哪个工作区、哪个对话里执行

QQ 消息进来后，需要一个 Agent 来跑。面板上的两个下拉框决定这件事：

```text
工作区  [ dsh-remote            ▾ ]
对话    [ 修复面板空白问题        ▾ ]
```

- **工作区下拉框**列出 `$DSH_HOME/storages/workspace.json` 里所有工作区，显示**标题**而不是路径
- **对话下拉框**列出该工作区下所有历史对话，同样显示**标题**
- 子 Agent（`origin: 'subagent'`）和已归档的对话会被过滤掉
- 改动立即生效并自动保存，不需要重启

它的行为是：

1. 选了对话 → 恢复该对话继续跑
2. 只选了工作区 → 在该工作区新建对话
3. 都没选 → 用当前活跃的 Agent

点 **「重新扫描工作区/对话」** 可以刷新列表（新对话不会自动出现）。

跑完的结果会记住用的是哪个对话，下次继续在同一个对话里跑（`resume: true`）。

---

## 结果落在哪里

```text
$DSH_HOME/storages/dsh-remote-worker/results/<id>.json
```

Windows 上是：

```text
C:\Users\<你>\.dsh\storages\dsh-remote-worker\results\
```

每个结果文件包含：

| 字段 | 内容 |
| --- | --- |
| `id` | 结果标识，如 `qq-78cc5caf-...` |
| `mode` | `natural` / `exec` |
| `instruction` | 你发的那句话 |
| `prompt` | 实际交给 Agent 的提示 |
| `sessionId` | 在哪个对话里跑的 |
| `status` / `exitCode` | `ok` / `error`，退出码 |
| `stdout` | 输出。**natural 模式下这里是 Agent 的回复** |
| `stderr` | 错误输出 |
| `durationMs` | 耗时 |
| `sender` / `senderHash` | 发送者（脱敏显示 + 哈希） |
| `source` / `kind` | 来源标记，`qq` + `task-result` |

**这些文件会自动同步到手机**——如果你的同步插件覆盖了 `storages/` 目录（如 dsh-one-sync 的 state 同步），手机会在同一个相对路径拿到解密后的文件。

---

## 手机端读取结果

手机上注册了 `sync_read_result` 工具，Agent 可以直接调用：

```text
sync_read_result                       读最新一条未读结果
sync_read_result { "id": "qq-78cc…" }  读指定结果
sync_read_result { "id": "qq-78cc…", "offset": 65536, "limit": 65536 }   翻页
```

它做了什么：

- **扫描**结果目录，按时间排序
- **去重**已读过的 id（状态存在 `$DSH_HOME/dsh-remote-worker/reader-state.json`）
- **分页**stdout 超过 64KB 时返回 `truncated: true` 和 `nextOffset`，拿它当 `offset` 再读一次
- **追问**读完可选自动 `followup` 一条摘要给 Agent（`autoFollowup: true`）
- **加锁**并发读取用 `reader.lock`，30 秒过期

手机侧配置（`reader` 段，一般不用改）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pollMs` | `5000` | 轮询间隔 |
| `autoFollowup` | `true` | 读完是否自动追一条给 Agent |
| `retentionKeep` | `100` | 保留最近多少条 |
| `retentionMinAgeMs` | `300000` | 超过多久才允许清理 |
| `stdoutLimit` | `65536` | 单次返回字节数 |
| `maxStdoutLimit` | `262144` | 单次上限 |

> 电脑端 `reader` 不生效——读取器只在手机注册。

---

## 设置面板有什么

| 区域 | 可改 |
| --- | --- |
| 角色 | `role` |
| QQ 通道 | `enabled` `appId` `appSecret` `mode` `whitelist` `retentionKeep` |
| 执行目标 | 工作区下拉框、对话下拉框、重新扫描 |
| 命令白名单 | `allowCommands` |
| 目录白名单 | `allowCwd` |

**IPv6 地址、端口、token、离线队列这些不在界面上**——接口都还在，配置也原样保留，只是不再占用面板空间。需要时直接改配置文件或调 API。

---

## remote_execute 工具

电脑当 host 时，这个工具会出现在工具列表里。手机会用它把重活派过来。

```text
remote_execute { "command": "npm run build", "cwd": "D:\\PC\\my-app", "timeoutMs": 600000 }
```

| 参数 | 说明 |
| --- | --- |
| `command` | 必填，要执行的命令 |
| `cwd` | 工作目录，必须在 `allowCwd` 白名单内 |
| `timeoutMs` | 超时，有上限 |

**安全限制：**

- `allowCommands` **默认是空的，等于拒绝所有命令**。第一次用 `remote_execute` 之前必须设：面板里填 `*`（全部放开），或按 glob 收窄成 `npm *`、`git *`、`node *`
- `allowCwd` 默认只允许用户主目录，超出范围报 `ERR_REJECTED`
- 每台机器有 `workerName`，多个 worker 时用来区分

---

## HTTP 接口

全部保留，前缀 `/dsh-remote-worker/api2/`：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 运行状态、能力探测、QQ 状态 |
| GET | `/config` | 读配置（敏感字段脱敏） |
| POST | `/config` | 改配置 |
| GET | `/qq-remote` | 读 QQ 目标（工作区/对话/各字段） |
| POST | `/qq-remote` | 改 QQ 目标，改动立即生效 |
| GET | `/workspaces` | 工作区与对话列表（带标题） |
| POST | `/workspaces` | 强制重新扫描 |
| POST | `/token` | 轮换访问 token |

`/status` 里有几个好用的诊断字段：

```text
routesMounted     挂了几条路由，正常是 5
webServerMissing  有没有拿到 webServer 服务
routesStale       路由有没有被上一个实例占着
```

面板打不开或请求 404 时，先看这三个。

---

## 配置文件

```text
Windows   %USERPROFILE%\.dsh\remote-worker.json
鸿蒙      /data/storage/el2/base/haps/entry/files/engine/home/remote-worker.json
```

完整结构（都是默认值）：

```json
{
  "role": "auto",
  "workerName": "<当前机器名>",
  "port": 3099,
  "token": "",
  "peerHost": "",
  "peerPort": 3099,
  "onOffline": "",
  "connectTimeoutMs": 3000,
  "defaultTimeoutMs": 120000,
  "maxTaskMs": 3600000,
  "maxConcurrent": 1,
  "allowCommands": [],
  "allowCwd": ["C:\\Users\\<你>"],
  "qq": {
    "enabled": false,
    "appId": "",
    "appSecret": "",
    "apiBase": "https://api.bot.qq.com",
    "tokenUrl": "https://bots.qq.com/app/getAppAccessToken",
    "intents": 33554432,
    "shard": [0, 1],
    "whitelist": [],
    "mode": "natural",
    "prefix": "/exec",
    "sessionId": "",
    "cwd": "",
    "timeoutMs": 120000,
    "maxQueue": 8,
    "resume": true,
    "retentionKeep": 200,
    "retentionMinAgeMs": 3600000,
    "cleanupIntervalMs": 3600000
  },
  "reader": {
    "targetSessionId": "",
    "autoFollowup": true,
    "pollMs": 5000,
    "retentionKeep": 100,
    "retentionMinAgeMs": 300000,
    "stdoutLimit": 65536,
    "maxStdoutLimit": 262144
  }
}
```

改完保存，面板重新加载即可。改 `role` 和 `port` 需要重启 DSH。

---

## 出错对照表

| 错误码 | 含义 | 怎么办 |
| --- | --- | --- |
| `ERR_WORKER_OFFLINE` | 电脑端不可达 | 检查电脑端是否运行、IPv6 是否可达 |
| `ERR_TIMEOUT` | 超时 | 加大 `timeoutMs` 重试一次 |
| `ERR_AUTH_FAILED` | token 不对 | 两边 `token` 要一致 |
| `ERR_REJECTED` | 被白名单拦了 | 检查 `allowCwd`、`allowCommands` |
| `ERR_ROLE_UNSUPPORTED` | 当前环境不支持该角色 | 手机不能当 host |
| `ERR_PORT_IN_USE` | 端口被占 | 换 `port` |
| `ERR_EXEC` | 命令本身失败 | 看 `stderr` |

---

## 常见问题

**面板显示「请求失败 HTTP 404」**
后端路由没挂上。访问 `/dsh-remote-worker/api2/status` 看 `routesMounted`，是 0 就是 webServer 没拿到。

**面板空白一片**
前端渲染崩了。刷新页面；如果还空白，说明有 React 报错，看浏览器控制台。

**QQ 发了消息没反应**
1. 面板 `qq.state` 是不是 `ready`
2. `gateway.sessionActive` 是不是 `true`
3. `whitelist` 留空表示允许所有人；填了就必须在里面
4. `mode: exec` 时消息必须以 `/exec ` 开头

**电脑没有公网 IPv6**
IPv6 直连需要真的公网地址。没有的话用 QQ 通道——它走 WebSocket 出站长连接，不需要公网 IP。看 `/status` 的 `capabilities.ipv6.hasGlobal`。

**手机上没看到结果**
结果是一层文件同步，不是推送。链路要走通三步：

1. 电脑端真的生成了文件：`~/.dsh/storages/dsh-remote-worker/results/<id>.json`
2. 同步插件把它传到云端，再到手机的 `engine/home/storages/dsh-remote-worker/results/`
3. 手机端 Agent 调 `sync_read_result` 才读得到

任何一步缺失都看不到。先用 `curl /api2/status` 确认 `qq.state=ready`，再看电脑上文件是否存在。

---

## 开发

```bash
npm test        # 20 项：协议、分帧、能力探测、执行器
npm run qq-test # 19 项：QQ 协议、通道、结果、分页、清理
npm run ui-test # 面板渲染、hooks 稳定性
npm run probe   # 环境探测
```

`ui-test` 会断言四个渲染路径（加载中、已加载、有工作区、有远端快照）产生的 hook 数量一致。往组件里加 hook 时别放到提前 `return` 后面，否则这个测试会失败，而线上表现就是面板空白。

### 目录

```text
index.js            宿主入口、路由、工具注册
client.js           设置面板（React，同款跑在电脑和手机）
core/               协议、分帧、执行器、能力探测、工作区扫描
core/qq/            QQ 通道、网关、协议、结果落盘
scripts/            测试与探测脚本
```

---

## 已知限制

- QQ 通道只收不发，结果通过文件传递
- IPv6 直连需要电脑有公网 IPv6 地址
- 手机端不能当 host（无 shell）
- 工作区列表基于 `workspace.json`，新建对话后需要手动点「重新扫描」
- 单个结果文件上限 45MB，但 one-sync 单文件同步上限由它自己决定

## License

MIT
