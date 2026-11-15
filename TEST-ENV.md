# dsh-remote-worker 测试环境清单

- 轮次编号：`ROUND-<YYYYMMDD>-<NN>`
- 测试日期：`<YYYY-MM-DD>`
- 测试人员：`<姓名>`
- 时区：`Asia/Shanghai`
- 对应测试计划：`TEST-PLAN.md`

> 本文件每轮测试单独复制一份，填入实际值。token 只保留后 4 位，截图和文本都不得出现完整 token。

## 1. 手机端

| 项目 | 实际值 | 采集位置/命令 |
| --- | --- | --- |
| 手机型号 | `<填写>` | 设置 → 关于手机 |
| HarmonyOS 版本 | `<填写>` | 设置 → 关于手机 |
| 系统补丁/构建号 | `<填写>` | 设置 → 关于手机 |
| DSH 鸿蒙版名称与版本 | `<填写>` | 应用内“关于”/安装包信息 |
| 鸿蒙 DSH 引擎版本 | `<填写>` | `<engine>/lib/node_modules/@deepseek-ai/dsh/package.json` |
| 插件版本 | `1.0.0` | `<engine>/home/profiles/web/node_modules/dsh-remote-worker/package.json` |
| 插件安装方式 | `<插件页安装/GitHub/手动复制>` | 插件页记录 |
| 插件启用状态 | `<启用/停用>` | 插件页 |
| `DSH_HOME` | `<填写>` | 原生启动参数，通常为 `<engine>/home` |
| 配置文件路径 | `<填写>` | 通常为 `$DSH_HOME/remote-worker.json` |
| 手机 IPv6 地址 | `<填写>` | 设置 → WLAN → 当前网络 → IP 地址 |
| 手机 IPv6 类型 | `<全局/链路本地/无>` | 同上 |
| 网络类型 | `<家宽 Wi-Fi / 蜂窝 / 热点>` | 手机状态栏 |
| 运营商 | `<填写>` | 手机设置 |
| 手机防火墙/省电限制 | `<填写>` | 设置 → 应用 → DSH → 流量/电池 |

手机端配置快照（脱敏）：

```json
{
  "role": "<auto/client>",
  "port": 3099,
  "token": "****<后4位>",
  "tokenLength": "<填写>",
  "peerHost": "<电脑 IPv6>",
  "peerPort": 3099,
  "workerName": "<填写>",
  "allowCommands": ["<填写>"],
  "allowCwd": ["<填写>"],
  "connectTimeoutMs": 3000,
  "defaultTimeoutMs": 120000,
  "maxTaskMs": 3600000,
  "maxConcurrent": 1,
  "onOffline": "offline-queue-test"
}
```

## 2. 电脑端

| 项目 | 实际值 | 采集位置/命令 |
| --- | --- | --- |
| 电脑型号 | `<填写>` | 系统信息 |
| Windows 版本与构建号 | `<填写>` | `winver` |
| Node 版本 | `<填写>` | `node -v` |
| DSH 桌面版版本 | `<填写>` | 应用“关于”/安装信息 |
| DSH 桌面 profile | `<填写>` | `C:\Users\<用户名>\.dsh\profiles\<profile>` |
| 插件版本 | `1.0.0` | `<profile>\node_modules\dsh-remote-worker\package.json` |
| 插件安装方式 | `<插件管理器/手动复制>` | 插件页记录 |
| 插件启用状态 | `<启用/停用>` | 插件页 |
| 电脑端 shell 类型 | `<PowerShell / Bash>` | DSH 工具环境/预设 |
| 电脑端 `ctx.shell` 可用 | `<是/否>` | 插件状态/启动日志 |
| `DSH_HOME` | `<填写>` | 通常为 `C:\Users\<用户名>\.dsh` |
| 配置文件路径 | `<填写>` | 通常为 `C:\Users\<用户名>\.dsh\remote-worker.json` |
| 电脑 IPv6 地址 | `<填写>` | 下方命令 |
| 电脑 IPv6 类型 | `<全局/临时/链路本地>` | 下方命令 |
| 路由器 IPv6 | `<开启/关闭/不可控>` | 路由器管理页 |

电脑端 IPv6 采集：

```powershell
Get-NetIPAddress -AddressFamily IPv6 |
  Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SuffixOrigin,AddressState,ValidLifetime,PreferredLifetime |
  Format-Table -AutoSize
```

临时地址识别：

```powershell
Get-NetIPAddress -AddressFamily IPv6 |
  Where-Object { $_.SuffixOrigin -eq 'Random' } |
  Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SuffixOrigin,AddressState,ValidLifetime,PreferredLifetime
```

填写表：

| 接口 | IPv6 地址 | 全局/临时/链路本地 | PrefixOrigin | SuffixOrigin | AddressState | ValidLifetime | PreferredLifetime |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` |
| `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` | `<填写>` |

电脑端配置快照（脱敏）：

```json
{
  "role": "<auto/host/client>",
  "port": 3099,
  "token": "****<后4位>",
  "tokenLength": "<填写>",
  "peerHost": "<填写>",
  "peerPort": 3099,
  "workerName": "<填写>",
  "allowCommands": ["<填写>"],
  "allowCwd": ["<填写>"],
  "connectTimeoutMs": 3000,
  "defaultTimeoutMs": 120000,
  "maxTaskMs": 3600000,
  "maxConcurrent": 1,
  "onOffline": "offline-queue-test"
}
```

## 3. 网络与 IPv6 路径

| 项目 | 实际值 | 说明 |
| --- | --- | --- |
| 运营商 | `<填写>` | 家宽/蜂窝 |
| 接入方式 | `<PPPoE/DHCPv6/SLAAC/蜂窝>` | 路由器或手机 |
| 电脑全局 IPv6 | `<填写>` | 必须为可被手机访问的全局地址 |
| 手机全局 IPv6 | `<填写>` | 用于确认两端都有 IPv6 |
| 两端是否同一运营商 | `<是/否>` | 跨运营商也可，记录即可 |
| 电脑是否有临时 IPv6 | `<是/否>` | `SuffixOrigin=Random` |
| 是否有 IPv6 防火墙 | `<是/否>` | 路由器/电脑 |
| 是否有 NAT64/DS-Lite | `<是/否/未知>` | 记录，不阻断纯 IPv6 测试 |
| 是否有中继/隧道 | `否` | 本插件不使用 |

IPv6 连通性预检（电脑本机）：

```powershell
# 监听检查
Get-NetTCPConnection -LocalPort 3099 -State Listen |
  Format-Table LocalAddress,LocalPort,State,OwningProcess -AutoSize

# 健康检查；PowerShell 失败时用 curl.exe
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

## 4. 防火墙与路由器

| 项目 | 实际值 | 采集方式 |
| --- | --- | --- |
| Windows 防火墙状态 | `<开启/关闭/域/专用/公用>` | `Get-NetFirewallProfile` |
| 3099 入站规则名称 | `dsh-remote-worker 3099` | `Get-NetFirewallRule` |
| 3099 入站规则状态 | `<启用/禁用>` | 同上 |
| 3099 规则协议/端口 | `TCP/3099` | `Get-NetFirewallPortFilter` |
| 路由器型号 | `<填写>` | 路由器管理页 |
| 路由器固件 | `<填写>` | 路由器管理页 |
| IPv6 模式 | `<Native/DHCPv6/PPPoE/关闭>` | 路由器管理页 |
| IPv6 防火墙 | `<开启/关闭>` | 路由器管理页 |
| 入站 3099 放行 | `<是/否>` | 路由器管理页 |
| 防火墙日志路径 | `%SystemRoot%\System32\LogFiles\Firewall\pfirewall.log` | 若已开启 |

采集命令（`New-NetFirewallRule` 需管理员 PowerShell）：

```powershell
Get-NetFirewallProfile |
  Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction

Get-NetFirewallRule -DisplayName "dsh-remote-worker 3099" -ErrorAction SilentlyContinue |
  Select-Object DisplayName,Enabled,Direction,Action,Profile

Get-NetFirewallRule -DisplayName "dsh-remote-worker 3099" -ErrorAction SilentlyContinue |
  Get-NetFirewallPortFilter
```

## 5. 安装与版本证据

- 手机端插件页截图：`TEST-LOGS/<轮次>/ENV/phone-plugin.png`
- 电脑端插件页截图：`TEST-LOGS/<轮次>/ENV/pc-plugin.png`
- 两端 `package.json` 版本字段截图：`TEST-LOGS/<轮次>/ENV/versions.txt`
- 两端配置快照（脱敏）：`TEST-LOGS/<轮次>/ENV/phone-config.redacted.json`、`pc-config.redacted.json`
- 电脑端 IPv6 列表：`TEST-LOGS/<轮次>/ENV/pc-ipv6.txt`
- 手机端 IPv6 截图：`TEST-LOGS/<轮次>/ENV/phone-ipv6.png`

## 6. 环境结论

| 检查项 | 结论 |
| --- | --- |
| 两端插件版本一致 | `<是/否>` |
| 电脑端 3099 监听 | `<是/否>` |
| 健康检查通过 | `<是/否>` |
| 手机端显示“仅客户端” | `<是/否>` |
| 两端均有全局 IPv6 | `<是/否>` |
| 电脑端有临时 IPv6 | `<是/否>` |
| 路由器放行 TCP 3099 | `<是/否/未知>` |
| 可执行地址变化用例 | `<是/否>` |
| 可执行临时地址用例 | `<是/否>` |

环境阻塞记录：

```text
<填写环境阻塞原因、证据路径、判定 BLOCK 的用例编号>
```

## 7. 脱敏与归档

- `token` 只保留后 4 位；截图打码。
- `onOffline`、`peerHost`、`allowCwd` 可保留，但归档前确认不含个人敏感路径。
- 不记录完整 token、完整环境变量、Cookie、私钥。
- 每轮一个 `TEST-LOGS/<轮次>/` 目录，不覆盖上一轮。
- 环境文件命名：`TEST-ENV-<轮次>.md`，与日志目录同轮次。
