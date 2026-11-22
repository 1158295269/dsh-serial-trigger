---
name: dsh-serial-trigger
description: 抓串口、留证据、按工作区脚本打故障点、用状态机替模型做实时收发。当需要打开/录制串口、回查某次调试、定位可疑字节、或让一个脚本顶住实时性时使用。
---

# 串口助手（v0.3.7，18 个工具）

## 什么时候用

| 要做的事 | 走哪条 |
|---|---|
| 抓一段设备输出、留证据 | A |
| 回查历史调试（"那个错误上哪去了"） | B |
| 让脚本判定故障点（时序/协议/丢包） | C |
| 对设备做毫秒级收发、超时重试（模型跟不上） | D |

## 铁律

1. **实时交给状态机，判定交给脚本，模型只当规划者。** 一轮思考几秒到几十秒，设备窗口常常几十毫秒；不要逐字节参与。
2. **一个端口只有一个写者。** 工具 `serial_open` 自动接管（被顶掉的会话正常收尾落盘）；非持有者只能 `serial_tail` 只读，写入/关闭得到 `E_NOT_OWNER`。
3. **录制即证据。** 锚点是 `captureId`；上下文被压缩后先 `serial_captures` 找回。模型**不能删录制**（`serial_cleanup` 只读）；只有用户归档会话时其录制才会被删。

## A 现场抓一段

```
serial_ports                                            → [{portId, port, state, captureId, owner, idleForMs}]
serial_open {port, baudRate?=115200, project?, conversation?}   → {portId, captureId, path, kind}
serial_tail {portId, cursor?, maxLines?=200, timeoutMs?=0, lineEnding?='any'|'crlf'|'lf'}
serial_send {portId, text?|hex?, append?='none'|'cr'|'lf'|'crlf'}
serial_close {portId}                                   → {path, bytesRx, bytesTx, lines}
```

- 落盘：`<dataRoot>/<project>/<端口>-<YYYYMMDD-HHMMSS>.slog`。Windows 保留名会被改写：`COM8` → 文件名/`captureId` 为 `_COM8-…`（正常现象）。
- `serial_tail` 返回 `{cursor, lines:[{t,seq,text,dir,partial}], pending, head, state, bytesRx, bytesTx, startedAt}`：`seq` 是该方向**字节偏移**，不是行号；省略 `cursor` = 回看 ring 尾部（约 256KB）；`pending` 是未断行残片，不是丢包；`timeoutMs>0` 是长轮询，比 tight loop 省调用。
- `serial_send`：`text` 与 `hex` 只能给一个；设备通常要**行尾**才把输入当一行回显（`append:'lf'` 或 `'crlf'`），`none` 可能只回显裸字节。发送也会进录制（tx 方向）。
- `serial_close` 要等落盘：几十 MB 的录制可能占用几秒；调用超时先用 `serial_ports` 核对该 portId 状态，不要盲目重发 open。
- 用完必须 close；不自动重连，掉线（`E_DEVICE_LOST`）要重新 open。

## B 回查历史

```
serial_captures {project?, since?, until?, keyword?, limit?=20}   → {captures:[{id, project, conversation, session_id, port, baud, path, started_ms, ended_ms, bytes_rx, lines, origin, digest}]}
serial_grep {captureId, pattern, context?=2, maxHits?=50}        → {captureId, hits:[{line, seq, tWallMs, dir, text, before:[{line,text}]}], count}
serial_export {captureId, format?='text'|'hex'|'csv', timestamps?=true, encoding?, out?}   → {path, format, bytes, lines}
```

- 先 `serial_grep`（0 命中就是真没有，不是错误）；不要把整段录制读进上下文，需要上下文时看 `before` / `serial_bytes`。
- `serial_export` 只读，不改 `.slog`；`out` 省略时与源同目录同名。
- 上下文被压缩后：先 `serial_captures`，别凭记忆猜 id。

## C 故障点（工作区脚本，事后重扫）

- 脚本必须是工作区根下的 `.mjs/.js/.cjs`，导出 `createScanner(ctx)` → `{record(rec), finish?()}`。
- `record(rec)` 入参：`{t, monoUs, dir:'rx'|'tx', offset, data:Buffer}`；每次返回 **mark 数组或单个 mark**（不返回 = 无标记）；`finish()` 可在结尾补一条，返回值规则相同。
- mark 字段：`anchor:{dir,offset,length}`（`offset` 必填）、`label`、`kind:'fault'|'state'|'note'`、`severity:'error'|'warn'|'info'`、`t`、`code:{file,symbol}`、`hypothesis`、`next:[{label, expect?}]`（对象数组，不是字符串）、`extra`。
- 沙箱：不能 `import`；只有 `Buffer` 与空 console；默认 20s 超时（`timeoutMs` 可调）、可取消、最多 5000 条 mark。
- **工作区根**：默认是宿主进程工作目录（DSH 桌面端通常是 `<用户>\.dsh\profiles\desktop`），不是当前对话的工作目录；**相对路径也按宿主 cwd 解析**。不确定时直接 `serial_scan`：`E_SCRIPT_OUTSIDE_WORKSPACE` 或 `E_NO_SUCH_SCRIPT` 的 message/hint 会给出允许的绝对根。场景文件同理（或直接传场景对象，绕开路径）。

```
serial_scan {captureId, script, label?, timeoutMs?=20000}   → {captureId, label, script, scannedBytes, marks(数量), truncated, file}
serial_marks {captureId, rule?, severity?, beforeMs?=300, afterMs?=1000}   → {captureId, count, sources, marks:[{id, rule, anchor, t, kind, severity, label, code?, hypothesis?, next?, window:{dir,offset,length}}]}
serial_bytes {captureId, dir:'rx'|'tx', offset, length≤8192, format?='hex'|'text'|'base64'}   → {dir, offset, length, truncated, body}（请求越过文件尾会截断并置 truncated）
```

- marks 只存引用不存文本：看内容用 `serial_bytes`（hex 是真相）。同一脚本同一录制重扫幂等。
- 判定是**事后**的：不监听、不触发、不自动重扫。

## D 状态机（实时执行者）

```
serial_fsm_simulate {captureId, scenario, tailMs?}      → {state, trace, marks, sends}   ← tailMs = 最后一条录制之后再推进的毫秒数
serial_fsm_start {portId, scenario}                    → {runId, mode:'live', portId, status}
serial_fsm_wait {runId, timeoutMs?=5000}               → {runId, status, marks}   ← 长轮询下一次转移或超时
serial_fsm_event {runId, name}                         → {runId, status, marks}   ← 注入 event:<name>
serial_fsm_status {runId}                              → {runId, portId, alive, marks, status}
serial_fsm_stop {runId}                                → {runId, stopped, persisted, trace}
```

```json
{
  "name": "握手",
  "initial": "idle",
  "states": {
    "idle": {
      "on": {
        "event:start": {
          "send": "PING\n",
          "expect": "line:/PING/",
          "waitMs": 800,
          "goto": "linked",
          "onTimeout": { "retry": 2, "retryDelayMs": 100, "goto": "recovering",
                         "mark": "设备没回显", "severity": "warn" }
        },
        "line:/^READY/": { "goto": "ready" }
      },
      "after": { "ms": 5000, "goto": "recovering", "mark": "5 秒没输出", "severity": "warn" }
    },
    "ready": { "on": {} },
    "linked": { "on": {} },
    "recovering": { "on": {} }
  }
}
```

- 转换键只有两种：`event:<name>`（`serial_fsm_event` 注入，**只有 live 能注入**）和 `line:/正则/`（设备某一行匹配）。
- 转换动作：`send` / `expect`（同 matcher 写法）/ `waitMs` / `goto` / `else`（超时兜底目标）/ `mark` / `severity` / `extra`。
- **写了 `send` 就必须同时写 `expect` + `waitMs` + `goto`**（不发盲包，否则 `E_BAD_SCENARIO`）；纯转换只要 `goto`。
- `onTimeout`：`retry`(0..10)、`retryDelayMs`、`goto`、`mark`、`severity`、`stop:true`（停机）。
- 状态级 `after`：`{ms, goto, mark?, severity?}`，到点自动跳。**自环（goto 回自己）会重置计时**，所以“安静超时”要放在没有自环的状态；`simulate` 的时钟锚定第一条录制，initial 态的 after 不会在首行乱触发。
- `scenario` 传对象，或 `{path}` 指向工作区 `.json`（≤256KB）。
- 一端口一机器：重复 start → `E_FSM_BUSY`；只有端口持有者能 start（否则 `E_NOT_OWNER`）。端口 close/被接管/会话结束 → 机器自动停，`runId` 失效（`E_NO_SUCH_RUN`）。
- 先 `simulate`（不碰端口，不能注入 event，发送只记录不执行）再 live；`trace` 每项 `{at, from, to, via, note}`，`status` 是 `{name, state, enteredAt, waitingFor, stopped, events, lines, trace}`。

## 录制归属与清理

- `origin='agent'`（工具开的）/ `'human'`（面板开的）；**人的录制永不自动删除**。
- `serial_cleanup({olderThanDays?, keepLast?, project?, includeHuman?})` 只读，返回保留计划 `{planId, count, skippedHuman, bytes, items, truncated}`；传 `planId` → `E_READ_ONLY`（删除不是模型能发起的动作）。
- **归档即清**：用户归档会话时，该会话的录制被删；**关闭会话/子 agent 结束不删**（v0.3.6 起）。宿主退出不删。

## 错误码速查

| 码 | 含义 | 怎么做 |
|---|---|---|
| `E_PORT_NOT_FOUND` | portId 未开或已关 | `serial_ports` 后 `serial_open` |
| `E_NOT_OWNER` | 端口不是你的 | 写入/关闭前 `serial_open` 接管；只读用 `serial_tail` |
| `E_PORT_REPLACED` | 该 portId 已被别人接管 | 重新 `serial_open` |
| `E_CAPTURE_BUSY` | 录制中的文件不能删 | 先 `serial_close` |
| `E_NO_SUCH_CAPTURE` | captureId 未知 | `serial_captures` 查 |
| `E_BAD_SCENARIO` | 场景校验失败 | 按 message 改（initial/goto/expect 必填项） |
| `E_SCENARIO_OUTSIDE_WORKSPACE` / `E_NO_SUCH_SCENARIO` | 场景路径不对 | 放进工作区根 / 检查路径 |
| `E_FSM_BUSY` / `E_NO_SUCH_RUN` | 端口已有机器 / runId 已失效 | 停旧的 / 重新 start |
| `E_SCRIPT_OUTSIDE_WORKSPACE` / `E_NO_SUCH_SCRIPT` | 脚本路径不对 | 按 hint 的根目录放 / 先写文件 |
| `E_SCAN_FAILED` | 脚本抛错或返回值不合契约 | 按 message 修脚本（record/finish 返回数组或单个 mark） |
| `E_SCAN_TIMEOUT` / `E_SCAN_CANCELLED` | 脚本超时/被取消 | 调大 `timeoutMs` 或修死循环；需要就重跑 |
| `E_READ_ONLY` | 清理工具不能删 | 只给计划；删除找用户 |
| `E_DATA_ROOT_INVALID` | 数据根不可写 | 检查插件 `dataRoot` 配置 |

## 常见坑

- 长轮询用 `timeoutMs`，不要 tight loop `serial_tail`。
- 大文件用 `grep`/`marks`/`bytes`，不要整段读。
- 改了场景/脚本就重跑 `simulate`/`serial_scan`；插件不缓存。
- 只有"说清期望回执 + 目标状态"才用 FSM 的 `send`；否则普通 `serial_send` + `serial_tail`。
- 板子必须 `serial_close`；面板里被模型接管的端口会显示「已被接管 · 只读」，读数不中断。
- 本版本没有触发器/自动唤醒：实时响应交给 FSM，事后判定交给扫描脚本。
