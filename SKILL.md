---
name: dsh-serial-trigger
description: 抓串口、回放录制、按工作区脚本给字节流打故障点、用状态机中间件替模型做实时收发。当需要打开/录制串口、查历史录制、定位可疑字节、或让一个脚本顶住实时性时使用。
---

# 串口助手

## 什么时候用

- 要看串口输出 / 发命令，并且想把过程自动留成文件当证据；
- 要回头查某次调试：按关键词找录制、导出、标出可疑字节；
- 协议有实时性要求，模型一轮思考太慢，需要一个状态机脚本替它收发。

## 基本链路

1. `serial_ports` —— 看有什么端口、谁在用；
2. `serial_open({port})` —— 打开并开始录制，返回 `portId` / `captureId`（captureId 是之后找回现场的锚点）；
3. `serial_tail({portId, cursor})` —— 增量读；上下文被压缩后用上次返回的 `cursor` 继续，不要重读全部；
4. `serial_send({portId, text|hex, append})` —— `append` 取 `none|cr|lf|crlf`；
5. `serial_close({portId})` —— 落盘，返回文件路径与字节数。

## 单写者模型（重要）

- 模型调 `serial_open` **一律自动接管**：上一个持有者的录制会正常收尾落盘，不会抛 E_PORT_BUSY；
- 非持有者写 / 关会得到 `E_NOT_OWNER`；想接管就重新 `serial_open`；
- 面板在别人持有时是只读的，显示「只读 · 由 Agent 持有」，被顶掉后显示「已被接管 · 只读」。

## 故障点（重扫，不是运行时插入）

- 规则是**工作区里的 .mjs 脚本**（`createScanner`），插件不内置、不注册规则；
- `serial_scan({captureId, script})` 扫一遍录制，标记只保存 `{dir, offset, length}` 引用，不存文本；
- `serial_marks({captureId})` 读标记；`serial_bytes({captureId, dir, offset, length})` 按引用取原始字节（给模型看解码前的数据）；
- 重扫是幂等的：同一脚本同一录制，标记 id 稳定。

## 状态机中间件

- 场景文件是工作区里的 `.json`；`serial_fsm_simulate({captureId, scenario})` 先离线跑通；
- `serial_fsm_start({portId, scenario})` 活体运行：agent 只发事件换模式，收发和等待由状态机负责；
- 一个端口只允许一个状态机；端口关闭或被接管时机器会一起停掉（不会挂在死环上）。

## 清理

`serial_cleanup({keepLast, olderThanDays, project})` 默认**只给计划**（条数、字节、前 50 条）；
确认无误后把返回的 `planId` 再传给 `serial_cleanup({planId})` 才真正删除。

## 常见错误怎么处理

| 错误 | 含义 | 做法 |
|---|---|---|
| `E_PORT_NOT_FOUND` | portId 已关闭 | `serial_ports` 重新确认，再 `serial_open` |
| `E_PORT_BUSY` | 只出现在直接调库路径 | 工具路径请直接 `serial_open`（自动接管） |
| `E_NOT_OWNER` | 端口不是你的 | 重新 `serial_open({port})` 接管 |
| `E_SCAN_TIMEOUT` | 脚本死循环或数据太大 | 修脚本或调大 `timeoutMs` |
| `E_SCAN_CANCELLED` | 调用被中止 | 需要就重跑 |

## 一个最小工作流

```
serial_ports
serial_open({ port: 'COM8' })            → portId 1, captureId 'COM8-...'
serial_tail({ portId: 1, timeoutMs: 2000 })
serial_send({ portId: 1, text: 'AT', append: 'crlf' })
serial_tail({ portId: 1, cursor: <上次的 cursor> })
serial_close({ portId: 1 })              → 返回录制路径
```
