---
name: dsh-serial-trigger
description: 抓串口、留证据、按工作区脚本打故障点、用状态机替模型做实时收发。当需要打开/录制串口、回查某次调试、定位可疑字节、或让一个脚本顶住实时性时使用。
---

# 串口助手（v0.3.5，18 个工具）

## 先记住三件事

1. **实时靠状态机，判定靠扫描脚本，模型只当规划者。** 一轮思考几秒到几十秒，设备窗口常常只有几十毫秒：模型不要逐字节参与，把时序交给 `serial_fsm_*`，把"可疑与否"交给工作区脚本。
2. **所有字节都录成 `.slog` 并进索引。** 现场锚点是 `captureId`；上下文被压缩后先 `serial_captures` 找回正在用的文件，不要重抓。
3. **一个端口只有一个写者。** 工具 `serial_open` = 自动接管（被顶掉的会话正常收尾落盘）；非持有者写入/关闭得到 `E_NOT_OWNER`，只读用 `serial_tail`。

## 四条工作流

### A. 现场抓一段

```
serial_ports
serial_open({ port: 'COM8' })            → { portId, captureId, path, kind }
serial_tail / serial_send
serial_close({ portId })                 → { path, bytesRx, bytesTx, lines }
```

- `serial_open` 参数：`{port, baudRate?=115200, project?, conversation?, sessionId?}`；`port` 支持 `MOCK:xxx`（无需硬件）。
- 落盘路径：`<dataRoot>/<工程>/<端口>-<YYYYMMDD-HHMMSS>.slog`（同一分钟重名自动加 `-2`/`-3`）；一个端口一个文件。
- 用完必须 `serial_close`，否则录制不收尾、端口一直被占。

### B. 增量读（不要整段重读）

`serial_tail({ portId, cursor?, maxLines?=200, timeoutMs?=0, lineEnding?:'any'|'crlf'|'lf' })`

返回 `{ cursor, lines:[{t,seq,text,dir,partial}], pending, head, state, bytesRx, bytesTx, startedAt }`。

- 省略 `cursor` = 回看 ring buffer 尾部（约 256KB），不是"从此刻开始"；之后拿返回的 `cursor` 继续。
- `timeoutMs > 0` 是长轮询：没数据也会等到有行或超时再返回，比 tight loop 省调用次数。
- `pending` 是还没断行的残片（更新中的最后一行），不是丢包。
- 断行策略：`any`（默认，`\r` 或 `\n`）|`crlf`（只有 `\r\n`）|`lf`。

### C. 事后追查（别把大文件读进上下文）

```
serial_captures({ project?, since?, until?, keyword?, limit?=20 })
serial_grep({ captureId, pattern, context?=2, maxHits?=50 })
serial_export({ captureId, format?:'text'|'hex'|'csv', timestamps?=true, encoding?:'utf-8'|'gbk'|'latin1', out? })
```

- `keyword` 在 digest 里模糊匹配（如 `i2c` / `timeout`），多数反查不用打开大文件。
- `serial_export` 只读，不改 `.slog`；`out` 省略时与源文件同目录同名 `.txt`。

### D. 实时协议（状态机）

```
serial_fsm_simulate({ captureId, scenario, tailMs? })   ← 先离线对着录制验场景
serial_fsm_start({ portId, scenario })                 → { runId, mode:'live', portId, status }
serial_fsm_status({ runId })                           ← 状态 / 可注入事件 / 最近轨迹
serial_fsm_wait({ runId, timeoutMs?=5000 })            ← 长轮询：等下一次转移或超时
serial_fsm_event({ runId, name })                      ← 注入 event:xxx 换模式
serial_fsm_stop({ runId })                             ← 停止，把过程中 marks 落进录制
```

- `scenario` 传场景对象，或 `{ path: '...' }` 指向工作区里的 `.json`（≤256KB、必须在工作区内）。
- 一端口一机器：重复 start 得 `E_FSM_BUSY`；只有端口持有者能 start。
- 端口被 `serial_close`、被接管、或会话结束时，机器自动停；`runId` 随 `E_NO_SUCH_RUN` 失效。

## 场景 JSON 语法

```json
{
  "name": "心跳握手",
  "initial": "idle",
  "states": {
    "idle": {
      "on": {
        "event:start": {
          "send": "PING",
          "expect": "line:/^PONG/",
          "waitMs": 800,
          "goto": "ready",
          "onTimeout": { "retry": 2, "retryDelayMs": 100, "goto": "recovering",
                         "mark": "设备没回 PONG", "severity": "warn" }
        },
        "line:/READY/": { "goto": "ready" }
      },
      "after": { "ms": 5000, "goto": "recovering", "mark": "5 秒没动静", "severity": "warn" }
    },
    "ready": { "on": {} },
    "recovering": { "on": {} }
  }
}
```

- 转换键只有两种：`event:<名字>`（由 `serial_fsm_event` 注入）和 `line:/正则/`（设备某一行匹配）。
- 转换动作：`send`（字符串）、`expect`（同 matcher 写法）、`waitMs`、`goto`、`else`（超时兜底目标）、`mark`/`severity`/`extra`。
- **写了 `send` 就必须同时写 `expect` + `waitMs` + `goto`**——不允许发盲包。非发送的转换只需 `goto`。
- `onTimeout`：`retry`(0..10)、`retryDelayMs`、`goto`、`mark`、`severity`(info|warn|error)、`stop:true`（直接停机）。
- 状态级 `after`：`{ms, goto, mark?, severity?}`，到点自动跳。
- 校验失败回报 `E_BAD_SCENARIO`，按 message 改（initial/goto 必须存在、expect 要能编译、retry 0..10 等）。
- `simulate` 返回 `{ state, trace, marks, sends }`；live 的 `status` 返回 `{ name, state, enteredAt, waitingFor, stopped, events, lines, trace }`。

## 故障点（扫描脚本，事后重扫）

- 脚本是工作区里的 `.mjs/.js/.cjs`，导出 `createScanner(ctx)` → `{ record(rec), finish?() }`。
- `record(rec)` 入参：`{ t, monoUs, dir:'rx'|'tx', offset, data:Buffer }`；返回 mark 数组（或单个）。
- mark 字段（按代码）：`anchor:{dir,offset,length}`（`offset` 必填）、`label`、`kind:'fault'|'state'|'note'`、`severity:'error'|'warn'|'info'`、`t`、`code:{file,symbol}`、`hypothesis`、`next[]`、`extra`。
- 沙箱：脚本不能 `import` 模块，只有 `Buffer` 和空 console；默认 20 秒超时（`timeoutMs` 可调）、可被调用取消、最多 5000 条标记。
- 用法：`serial_scan` → `serial_marks`（只给引用和窗口）→ `serial_bytes`（`length ≤ 8192`，hex 是真相）。
- 重扫幂等：同一脚本同一录制，mark id 稳定；插件不保存规则，规则怎么管由工作区（git）决定。

## 录制归属与清理

- `origin=agent`（工具开的）/ `human`（面板开的）；**人的录制永不自动删除**。
- `serial_cleanup({ olderThanDays?, keepLast?, project?, includeHuman? })` **只读**：返回保留计划（count/bytes/skippedHuman）。传 `planId` 会被 `E_READ_ONLY` 拒绝——删除不是模型能发起的动作。
- **归档即清**：会话被归档时，它产生的所有录制会被删除（插件里唯一会自动发生的删除）；宿主退出不删。单文件删除有 5 秒超时保护。

## 错误码速查

| 码 | 含义 | 怎么做 |
|---|---|---|
| `E_PORT_NOT_FOUND` | portId 未开或已关 | `serial_ports` 后 `serial_open` |
| `E_PORT_BUSY` | 端口被占（只在直接调库时出现） | 工具路径直接 `serial_open`（自动接管） |
| `E_NOT_OWNER` | 端口不是你的 | 写入/关闭前先 `serial_open` 接管；只读用 `serial_tail` |
| `E_PORT_REPLACED` | 这个 portId 已被别人接管 | 重新 `serial_open` |
| `E_CAPTURE_BUSY` | 录制中的文件不能删 | 先 `serial_close` |
| `E_NO_SUCH_CAPTURE` | captureId 未知 | `serial_captures` 查 |
| `E_BAD_SCENARIO` | 场景校验失败 | 按 message 改场景 |
| `E_SCENARIO_OUTSIDE_WORKSPACE` / `E_NO_SUCH_SCENARIO` | 场景路径不对 | 放进工作区、检查路径 |
| `E_FSM_BUSY` | 该端口已有状态机 | `serial_fsm_status`/`serial_fsm_stop` 旧的 |
| `E_NO_SUCH_RUN` | runId 失效（端口关了或会话结束） | 重新 `serial_fsm_start` |
| `E_SCAN_TIMEOUT` | 脚本超时被杀 | 调大 `timeoutMs` 或修死循环 |
| `E_SCAN_CANCELLED` | 调用被中止 | 需要就重跑 |
| `E_SCRIPT_OUTSIDE_WORKSPACE` / `E_NO_SUCH_SCRIPT` | 脚本路径不对 | 放进工作区 / 先写文件 |
| `E_READ_ONLY` | 清理工具不能删 | 只给计划；删除请找用户 |
| `E_DATA_ROOT_INVALID` | 数据根不可写 | 检查 `dataRoot` 配置 |

## 常见坑

- 轮询用 `timeoutMs` 长轮询，不要 tight loop `serial_tail`。
- 大文件永远用 `grep`/`marks`/`bytes`，不要把整个 capture 读进上下文。
- 状态机先 `simulate` 再 `start`；场景改了就重跑 `simulate`。
- 只有"能说清期望回执和目标状态"时才用 FSM 的 `send`；否则用普通 `serial_send` + `serial_tail`。
- 不自动重连：掉线（`E_DEVICE_LOST`）要重新 `serial_open`；板子用完必须 `serial_close`。
- 面板与模型共享端口：模型接管后，面板上的旧 portId 会显示「已被接管 · 只读」，读数不中断。
- 本版本没有"触发器/自动唤醒"：实时响应交给 FSM，事后判定交给扫描脚本。
