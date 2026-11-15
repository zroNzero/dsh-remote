# dsh-remote-worker 测试记录

- 轮次编号：`ROUND-<YYYYMMDD>-<NN>`
- 测试日期：`<YYYY-MM-DD>`
- 测试人员：`<姓名>`
- 环境清单：`TEST-ENV-<轮次>.md`
- 测试计划：`TEST-PLAN.md`
- 日志根目录：`TEST-LOGS/<轮次>/`

## 1. 本轮环境摘要

| 项目 | 值 |
| --- | --- |
| 手机型号/系统 | `<填写>` |
| 手机 DSH 版本 | `<填写>` |
| 手机插件版本 | `<填写>` |
| 电脑型号/Windows | `<填写>` |
| 电脑 Node 版本 | `<填写>` |
| 电脑 DSH 版本 | `<填写>` |
| 电脑插件版本 | `<填写>` |
| 手机 IPv6 | `<填写>` |
| 电脑 IPv6 | `<填写>` |
| 网络类型/运营商 | `<填写>` |
| 路由器 IPv6 | `<开启/关闭>` |
| 防火墙 3099 | `<放行/未放行>` |
| 电脑 shell 类型 | `<PowerShell/Bash>` |
| token 后 4 位 | `****<填写>` |
| `onOffline` | `offline-queue-test` |

## 2. 用例结果总表

结果填 `PASS` / `FAIL` / `BLOCK`；问题编号填 `ISSUES.md` 中的编号，没有填 `—`。

| 用例 | 名称 | 结果 | 开始时间 | 结束时间 | 问题编号 | 电脑日志 | 手机日志 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-00 | 环境与安装自检 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-00/pc-*` | `TC-00/phone-*` |
| TC-01 | 在线 echo 与关闭 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-01/pc-*` | `TC-01/phone-*` |
| TC-02 | 流式与大输出 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-02/pc-*` | `TC-02/phone-*` |
| TC-03 | 非零退出与 stderr | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-03/pc-*` | `TC-03/phone-*` |
| TC-04 | 电脑端离线 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-04/pc-*` | `TC-04/phone-*` |
| TC-05 | 任务超时 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-05/pc-*` | `TC-05/phone-*` |
| TC-06 | 主动取消 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-06/pc-*` | `TC-06/phone-*` |
| TC-07 | 错误 token | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-07/pc-*` | `TC-07/phone-*` |
| TC-08 | 空命令白名单 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-08/pc-*` | `TC-08/phone-*` |
| TC-09 | cwd 越界 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-09/pc-*` | `TC-09/phone-*` |
| TC-10 | 执行中断网或切后台 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-10/pc-*` | `TC-10/phone-*` |
| TC-11 | IPv6 地址变化 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-11/pc-*` | `TC-11/phone-*` |
| TC-12 | 临时 IPv6 地址 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-12/pc-*` | `TC-12/phone-*` |
| TC-13 | 停用与端口释放 | `<结果>` | `<HH:MM:SS>` | `<HH:MM:SS>` | `—` | `TC-13/pc-*` | `TC-13/phone-*` |

## 3. 用例记录模板

每条用例复制以下区块，标题改为实际用例编号。

### TC-XX 用例名称

| 字段 | 内容 |
| --- | --- |
| 用例编号 | `TC-XX` |
| 用例名称 | `<填写>` |
| 覆盖路径 | `<在线/离线/超时/取消/安全/中断/地址/临时地址/生命周期>` |
| 执行时间 | `<YYYY-MM-DD HH:MM:SS +08:00>` |
| 执行人 | `<填写>` |
| 前置状态 | `<两端状态、网络、配置摘要>` |
| 执行结果 | `PASS / FAIL / BLOCK` |
| 问题编号 | `<ISSUES.md 编号 / —>` |
| 电脑日志路径 | `TEST-LOGS/<轮次>/TC-XX/pc-*.log` |
| 手机日志路径 | `TEST-LOGS/<轮次>/TC-XX/phone-*.log` |
| 截图路径 | `TEST-LOGS/<轮次>/TC-XX/*.png` |
| 返回原文路径 | `TEST-LOGS/<轮次>/TC-XX/payload.txt` |

#### 3.1 步骤执行

| 步骤 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- |
| 1 | `<填写>` | `<填写>` | `<截图/日志/命令输出>` |
| 2 | `<填写>` | `<填写>` | `<截图/日志/命令输出>` |
| 3 | `<填写>` | `<填写>` | `<截图/日志/命令输出>` |
| 4 | `<填写>` | `<填写>` | `<截图/日志/命令输出>` |
| 5 | `<填写>` | `<填写>` | `<截图/日志/命令输出>` |

#### 3.2 返回对象原文

```text
<粘贴工具返回的完整文本；离线用例必须包含 code、message、fallback、onOffline、task>
```

若 Agent 同时输出了结构化 JSON，原样粘贴：

```json
{
  "ok": "<true/false>",
  "taskId": "<填写>",
  "exitCode": "<填写>",
  "signal": "<填写>",
  "timedOut": "<填写>",
  "aborted": "<填写>",
  "durationMs": "<填写>",
  "stdout": "<填写>",
  "stderr": "<填写>",
  "error": {
    "code": "<填写>",
    "message": "<填写>",
    "fallback": "<填写>",
    "onOffline": "<填写>",
    "task": {
      "command": "<填写>",
      "cwd": "<填写>",
      "timeoutMs": "<填写>"
    }
  }
}
```

#### 3.3 电脑端状态证据

| 检查 | 命令/位置 | 结果 |
| --- | --- | --- |
| 3099 Listen | `Get-NetTCPConnection -LocalPort 3099 -State Listen` | `<填写>` |
| 3099 Established | `Get-NetTCPConnection -LocalPort 3099 -State Established` | `<填写>` |
| 目标进程 | `Get-CimInstance Win32_Process` 过滤命令 | `<填写>` |
| 健康检查 | `Invoke-RestMethod http://[::1]:3099/health` | `<填写>` |
| 防火墙上限流/拦截 | Windows 防火墙日志 | `<填写>` |

#### 3.4 日志归档检查

- [ ] `pc-host.log` / `pc-host.stdout.log` / `pc-host.stderr.log` 已保存，或已写明不可采
- [ ] `pc-port-listen.txt` 已保存
- [ ] `pc-port-established.txt` 已保存
- [ ] `pc-processes.txt` 已保存
- [ ] `phone-hilog.log` 或 `phone-hilog-filtered.log` 已保存
- [ ] `phone-network-hilog.log` 已保存（若环境可取）
- [ ] `payload.txt` 已保存
- [ ] 手机端返回截图已保存
- [ ] 设置页截图已保存（token 打码）
- [ ] 地址变化前后截图/命令输出已保存（TC-11、TC-12）
- [ ] 断网/后台前后截图已保存（TC-10）

#### 3.5 失败取证摘要

| 项目 | 内容 |
| --- | --- |
| 实际错误码 | `<填写>` |
| 预期错误码 | `<填写>` |
| 实际与预期差异 | `<填写>` |
| 是否出现本地替代执行 | `<是/否>` |
| 是否有进程/连接残留 | `<是/否>` |
| 是否可稳定复现 | `<是/否>` |
| 首次复现步骤 | `<填写>` |
| 日志时间窗 | `<开始时间 — 结束时间>` |

#### 3.6 备注

```text
<填写环境波动、重试、阻塞原因、对应用例的影响>
```

#### 3.7 恢复确认

- [ ] token 已恢复
- [ ] 命令白名单已恢复
- [ ] cwd 白名单已恢复
- [ ] `peerHost` 已恢复为可用地址
- [ ] 飞行模式已关闭
- [ ] 电脑端无残留进程
- [ ] 3099 监听状态符合下一用例前置条件

## 4. 本轮结论

| 项目 | 内容 |
| --- | --- |
| PASS 数 | `<填写>` |
| FAIL 数 | `<填写>` |
| BLOCK 数 | `<填写>` |
| 阻塞项 | `<填写>` |
| 严重问题编号 | `<填写>` |
| 是否满足核心命题 | `<是/否/无法判定>` |
| 结论说明 | `<填写>` |

## 5. 归档

- 本轮目录：`TEST-LOGS/<轮次>/`
- 环境清单：`TEST-ENV-<轮次>.md`
- 问题清单：`ISSUES.md`
- 返回原文：每个用例目录下的 `payload.txt`
- 截图：每个用例目录下的 `*.png`
- 日志：每个用例目录下的 `pc-*.log`、`phone-*.log`
- 归档前检查 token 已脱敏。
