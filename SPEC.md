# dsh-serial-trigger · 方案 v0.2

> 状态：草案（已吸收 Q1–Q5 答复，新增 Q6–Q13 待确认）。
> 当前阶段只做**中间层**：不碰 UI、不接硬件。

---

## 0. 环境核实（本机已验证）

| 项 | 结果 |
|---|---|
| Node | v24.21.0 |
| `node:sqlite` | 可用（`DatabaseSync`） |
| SQLite FTS5 | 已编译进 |
| `TextDecoder('gbk')` | 可用 |

索引层**零依赖**。

---

## 1. 范围

**做**：字节流 → 可订阅/可回放/可追溯；一次录制一个文件；跨对话反查。
**不做**（本阶段）：UI、串口硬件、触发器编辑器、权限模型、脱敏。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| Seq | 全局单调字节序号 |
| Batch | 一批连续字节 + 时间戳，投递最小单位 |
| Capture | 一次录制 = 一个 `.slog` |
| Project | 工程 = 工作区（自动取名） |
| Conversation | 对话；一个对话可产生多个 Capture（每端口各一组） |

---

## 3. 数据模型

```ts
interface Batch {
  portId: number
  seq: number            // 本批首字节全局序号
  bytes: Uint8Array      // 零拷贝 subarray
  dir: 0 | 1             // 0=rx 1=tx
  tMonoUs: number        // 单调微秒（排序/差值唯一依据）
  tWallMs: number        // 墙钟毫秒（仅显示）
  flags: number          // bit0 partial | bit1 gap | bit2 triggerMark
}
```

铁律：字节是唯一真相；seq 连续（丢包留洞并标记）；文本延迟解码且必须增量；单调时钟排序。

---

## 4. 自适应批处理

| 观测速率（近 200ms） | 批延迟 | 单批上限 |
|---|---:|---:|
| < 1 KB/s | 0（直通） | 1 KB |
| 1–100 KB/s | 4 ms | 16 KB |
| 100 KB/s–1 MB/s | 8 ms | 32 KB |
| > 1 MB/s | 16 ms | 64 KB |

- 首字节开始计时；距上批 > 500 ms 时**空闲直通**；换档需稳定 500 ms（回滞）。
- 真正的延迟下限是 Windows 驱动 16ms latency timer。

---

## 5. 发布订阅

| Topic | 载荷 | 订阅者 |
|---|---|---|
| `serial.stream` | Batch | 面板 / tail / 录制器 / 触发器 |
| `serial.status` | `{portId,from,to,reason}` | 面板 / 模型 |
| `serial.trigger` | `{portId,ruleId,fromSeq,toSeq,hits}` | 面板 / 模型 |
| `serial.capture` | `{captureId,path,event,bytes}` | 模型 |

```
subscribe(topic, { filter, cursor?, framing, queueBytes })
```

单端口有序；at-most-once + gap 标记；**绝不反压端口**；录制器/触发器是普通订阅者。

> v0.1 实现可以只有一个订阅者（录制器），但 **API 形状按多订阅者设计**，后面加面板不用改。

---

## 6. 文件布局

```
<dataRoot>/                          # 用户设置项
└─ <工程名>/                          # = 工作区文件夹名（清洗后）
   ├─ <对话名>-<端口>-<波特率>-<YYYYMMDD-HHMMSS>.slog
   └─ 同名的 .txt                     # 仅在导出时生成
```

**每端口独立文件**（一个对话开 COM3+COM4 → 两个文件），避免多写入者争用同一句柄。

- 对话名取会话标题；取不到用 `sessionId` 前 8 位。
- 端口名参与文件名：`COM3` → `COM3`，`/dev/ttyUSB0` → `ttyUSB0`（去分隔符）。
- 同秒重名追加 `-2`。

### 容器格式（append-only，无索引文件）

```
Header 64B: magic "DSHSLOG1" | ver u16 | flags u16 | headerSize u32
            | createdAt u64(ms) | port[24] | baud u32 | reserved
Record:     u32 payloadLen | u64 tMonoUs | u64 tWallMs
            | u8 kind(0rx 1tx 2mark 3gap 4trigger 5status)
            | u8 flags | u16 reserved | bytes[]
```

崩溃恢复：扫描到最后一条**完整**记录，尾部残缺字节截断并在 index 里记 `truncated=true`。

---

## 7. 索引与反向追溯

### 表结构（v0.1 只建一张表，FTS 留到需要时）

```sql
CREATE TABLE captures (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, conversation TEXT, session_id TEXT,
  path TEXT NOT NULL, port TEXT, baud INTEGER,
  started_ms INTEGER, ended_ms INTEGER,
  bytes_rx INTEGER, bytes_tx INTEGER, lines INTEGER, triggers INTEGER,
  clean_close INTEGER, truncated INTEGER, digest TEXT
);
CREATE INDEX ix_project_time ON captures(project, started_ms);
```

v0.1 的模糊查询用 `digest LIKE '%kw%'`；量大了再上 FTS5（编译选项已就绪）。

### digest（关闭时写）

首 20 行 / 末 20 行 / 错误行直方图（`error|err|fail|timeout|assert|reset`）/ 触发摘要。**多数反查靠 digest 就能命中，不必打开大文件。**

### 三条路径

| 你说 | 调用 | 预算 |
|---|---|---|
| "昨天调 I2C 那个问题" | `serial_captures({since,keyword})` | <10ms |
| "哪一行超时" | `serial_grep({captureId,pattern})` | 0.5–1s/200MB |
| "把那段导出来" | `serial_export({captureId,range})` | ~2s/200MB |

### 索引自愈
启动时校验 `path` 是否存在：不存在→标 `missing`（不删行）；`ended_ms IS NULL`→补算 digest。

---

## 8. 导出

`serial_export({captureId, range?, format:'text'|'hex'|'csv', timestamps=true, encoding:'utf8'|'gbk'|'latin1', out?})`

默认输出到同目录同名 `.txt`；**原始 `.slog` 永不修改**。

---

## 9. 设置

**配置文件放在固定位置，不能放进 dataRoot**（否则先有鸡还是先有蛋）：

```
~/.dsh/serial-trigger/config.json
{
  "dataRoot": "D:\\文档\\DSH文档库\\serial-logs",
  "retentionDays": 30,
  "retentionSizeGB": 20,
  "onExceed": "warn",              // warn | prompt-cleanup
  "defaultEncoding": "utf8",
  "defaultFraming": "line",
  "batch": { "adaptive": true, "maxDelayMs": 8, "maxBytes": 32768 },
  "redact": { "enabled": false, "rules": [] }
}
```

- UI 未做之前，由 `serial_config({...})` 工具读写；UI 做好后同一个文件由面板读写。
- 修改 `dataRoot` **不迁移**旧数据，只提示新目录（避免大批量移动失败）。

---

## 10. 路径适配（重点）

| 风险 | 处理 |
|---|---|
| 中文/空格/emoji 路径 | 全程按 UTF-8 处理，禁止把路径拼进 shell 命令 |
| 超长路径（>260） | 超过 240 字节时自动加 `\\?\` 前缀 |
| Windows 保留名 | `CON PRN AUX NUL COM1-9 LPT1-9` 作工程名时加 `_` 后缀 |
| 非法字符 | `<>:"/\\|?*` 与 0x00-0x1F → `-` |
| 结尾点/空格 | 主动 strip（Windows 会静默吞掉，导致"看着一样却打不开"） |
| 大小写不敏感 | 冲突检测用小写比较（`Src` / `src` 视为同名） |
| 同名工程 | 追加 4 位路径哈希：`C028_FW-1a2b`，并在 `project.json` 记全路径 |
| 网络盘 / OneDrive | 检测到就警告（fsync 慢、可能被同步进程锁） |
| 目录不可写 | `E_DATA_ROOT_INVALID`，返回可操作建议 |
| 路径穿越 | `captureId` 拼路径前必须 normalize + 前缀校验 |

---

## 11. 保留与清理

- 阈值：`retentionDays` 或 `retentionSizeGB`，先到为准；超限默认**只警告**。
- 清理由对话发起：`serial_cleanup({project?, before?, dryRun:true})` → 返回"将删除 N 个文件 / X GB / 时间范围" → 用户确认后 `serial_cleanup({planId})` 执行。
- **安全约束**：不动当前会话正在录的 capture；有打开句柄的跳过；只移不删（进 `.trash/`，再按 `.trash` 自己的保留策略下沉）。

---

## 12. 端口状态机

```
closed ──open()──▶ opening ──✓──▶ open ──close()──▶ draining ──flush──▶ closed
   ▲                  │              │                 ▲
   │                  └─✗──▶ error ◀─┴── 拔线/写失败 ────┘
```

`draining` 最多 2s；`error` **不自动重连**。

---

## 13. 错误码

统一外壳 `{ok:true,data}` / `{ok:false,error:{code,message,hint,fix[],retryable}}`。
`hint` 三要素：为什么 → 替代方案 → 能否重试。

`E_PORT_NOT_FOUND / E_PORT_BUSY / E_PERMISSION / E_BAUD_UNSUPPORTED / E_DEVICE_LOST /
E_OPEN_TIMEOUT / E_QUEUE_OVERFLOW / E_CAPTURE_IO / E_RULE_INVALID / E_NO_SUCH_CAPTURE /
E_DATA_ROOT_INVALID / E_CONFIG_INVALID`

---

## 14. 工具集

| 工具 | 参数 | 用途 |
|---|---|---|
| `serial_ports` | — | 列端口 |
| `serial_open` | `{port,baudRate,framing?,project?}` | 打开并录制 |
| `serial_close` | `{portId}` | 关闭并 flush |
| `serial_tail` | `{portId,cursor?,maxLines?,timeoutMs?}` | 增量读，返回新 cursor |
| `serial_send` | `{portId,text|hex,append}` | 发送 |
| `serial_captures` | `{project?,since?,until?,keyword?}` | 找回现场 |
| `serial_grep` | `{captureId,pattern,context?}` | 单文件检索 |
| `serial_export` | `{captureId,range?,format?,encoding?}` | 导出可读文本 |
| `serial_config` | `{...}` | 读写设置（UI 前） |
| `serial_cleanup` | `{dryRun,planId?}` | 两段式清理 |
| `serial_rules_add` | `{name,source,timeoutMs?}` | 安装/更新规则，装前语法检查（v0.2） |
| `serial_rules_list` | — | 列规则与上次运行结果（v0.2） |
| `serial_rules_apply` | `{captureId,rules?,timeoutMs?}` | 对某次录制重扫，写故障点（v0.2） |
| `serial_marks` | `{captureId,rule?,severity?,include?}` | 读故障点，只返回引用（v0.2） |
| `serial_bytes` | `{captureId,dir,offset,length,format?}` | 按引用取字节（v0.2） |

状态机接口 `serial_fsm_*` 留 v0.3，触发器 `serial_trigger` 留 v0.4。

---

## 15. 里程碑

| # | 内容 | 验收 |
|---|---|---|
| M1 ✅ | `codec` 容器编解码 | **已完成**：200MB 写 616 MB/s、读 249 MB/s、sha256 一致、尾部截断可恢复（6 项测试通过） |
| M2 ✅ | `hub` broker | **已完成**：多订阅者有序、慢订阅者丢最旧并打 gap、cursor 可回补（7 项测试） |
| M3 ✅ | 录制器 + 索引 + digest | **已完成**：SQLite 索引、digest 直方图、grep、导出、自愈（7 项测试） |
| M4 ✅ | `replay` 回放源 | **已完成**：按 tMonoUs 节奏回放，无硬件可用（e2e 内验证） |
| M5 ✅ | 工具层（接回放） | **已完成**：8 个工具 + 统一 ok/error 外壳，模拟 agent 全流程通过 |
| M6 | 真串口（`serialport`） | 阻塞：需要硬件 |
| M7 ✅ | UI（面板 + 路由） | **已完成**：日志 / Hex / 统计、搜索、只读历史、导出四格式 |
| M8 | 规则与故障点（v0.2） | 见第 21 节 |
| M9 | 状态机中间件（v0.3） | 见第 22 节 |
| M10 | 故障注入 + 黄金轨迹（v0.4） | 待定 |

---

## 16. 待确认（Q6–Q13）

| # | 问题 | 影响 |
|---|---|---|
| Q6 | 文件名用本地时间还是 UTC？ | 人看 vs 跨时区一致性 |
| Q7 | 崩溃尾部残缺：截断保留整条，还是保留残片？ | 数据完整性策略 |
| Q8 | 工程同名：加 4 位哈希还是加序号？ | 目录可读性 |
| Q9 | v0.1 索引是否直接用 SQLite？ | 复杂度 vs 未来 |
| Q10 | 会话标题改了，旧文件名要不要跟着改？ | 改名成本 |
| Q11 | `dataRoot` 改路径要不要提供"迁移"按钮（后期）？ | 体验 |
| Q12 | 是否需要"按工程打包 zip 发给同事"？ | 工具数量 |
| Q13 | 单文件上限：到 512MB 自动切新文件？ | 大文件打开成本 |


---

## 17. 测试矩阵（当前 25 项全绿）

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 容器 | `test/codec.test.mjs` | 6 | 往返一致、随机 512 条字节校验、崩溃截断、端口名裁剪、坏 magic、空文件 |
| 总线 | `test/hub.test.mjs` | 7 | 双订阅有序、慢订阅丢包+gap、cursor 回补、环形淘汰、行切分、跨批 UTF-8、JSONL |
| 存储 | `test/store.test.mjs` | 7 | 文件名清洗、索引+digest、grep 行号、text/hex 导出、工程同名哈希、recover、错误直方图 |
| 端到端 | `test/e2e.test.mjs` | 3 | 模拟 agent 全流程、结构化错误、回放源 |
| 入口 | `test/entry.test.mjs` | 2 | 8 个工具注册、坏 dataRoot 不抛异常 |

跑法：`node --test --test-force-exit test/*.test.mjs`


---

## 18. 断行策略（实现于 `src/lines.mjs`）

串口没有"行"，行是策略。三档，**不是显示开关，会改变一行里包含哪些字节**：

| 模式 | 断行条件 | 孤立 \r | 孤立 \n | 用在 |
|---|---|---|---|---|
| `any`（默认） | \r、\n、\r\n 都断 | 断 | 断 | AT 指令、printf 日志 |
| `crlf` | 只有 \r\n 断 | 数据 | 数据 | 载荷里可能含 0x0A 的二进制协议 |
| `lf` | 只有 \n 断 | 数据 | 断 | Unix 风格日志 |

两个实现细节：

1. **行尾的 \r 必须扣住不发**。一批数据以 \r 结尾时，下一批可能是 \n——先断行就会出现一条空行，且再也补不回来。M3/M4 两个用例专门盯这个。
2. **未断行的尾巴通过 `pending` 单独返回**，不混进 lines。面板把它渲染成最后一行浅色待续行，原地更新，而不是每收一批就多一行。

切换模式时，每种模式有自己独立的 LineAssembler 与 cursor：切回来不会拿到半截旧缓冲。代价是回看窗口受环形缓冲限制（默认 256KB），更早的日志按录制时的模式呈现。


---

> 版本管理与提交规范见 [GIT.md](GIT.md)。

## 19. 真串口（M6，部分完成）

`serialport@13.0.0` 已接入，适配层在 `src/serial-backend.mjs`，服务通过 `backend` 注入（测试可换假实现）。

| 能力 | 状态 |
|---|---|
| 枚举真实端口（含友好名） | ✅ COM1/COM4/COM6/COM7/COM8 |
| 打开 / 关闭 | ✅ COM1、COM6 实测通过 |
| 重复打开同一端口 | ✅ E_PORT_BUSY（自有簿记） |
| 不存在的端口 | ✅ E_PORT_NOT_FOUND，retryable=false |
| 驱动错误映射 | ✅ access denied→BUSY、file not found→NOT_FOUND、其他→E_OPEN_FAILED |
| 读取数据 → 录制 | ✅ 走 hub.publishData（未接硬件回环验证） |
| 写入数据 | ✅ 走 device.write + 镜像进流 |

**尚未验证**：真实设备回环收发（需要 com0com 或 TX-RX 短接）、拔线检测（onError → error 状态已有代码，未实测）。

`bin/serial-live.mjs <PORT> [baud]` 是现场验证脚本：枚举 → 打开 → 状态 → 重复打开 → 关闭 → 索引 → 假端口。


---

## 20. 硬件验收（只验 shell，不验固件）

`bin/shell-check.mjs <PORT> [baud]` —— 固件只要持续吐字节即可，所有断言都关于插件自己：

| 检查 | 证明什么 |
|---|---|
| A 无人读取时仍有字节落盘 | 录制是同步 tap，不依赖订阅者（这是 D04 修复的回归测试） |
| B 流与文件的 sha256 相同 | 字节透明：hub 里看到的和磁盘上写的是同一串字节 |
| C seq 无空洞、文件未截断 | 没有丢包，崩溃恢复没被触发 |
| D 写入的标记从回显里出现 | 发送路径真的到了线上（而不只是进了 hub） |
| E 8 次开合后句柄数不变、索引齐全 | 没有 fd 泄漏，每次录制都正确收尾 |

`bin/firmware-conformance.mjs` 是另一回事（PING/BURST/ECHO 那套），用来给固件做合格检查，跟插件质量无关，别混用。

---

## 21. 规则与故障点（v0.2）

### 21.1 定位

不做日志规范。嵌入式日志本来就不规范，要求对方改固件等于把插件推到“说服别人改造”的位置。
这一层只解决一件事：**抓到日志之后，谁能自动把可疑位置标出来，并且标得住**。

四条原则：

| 原则 | 含义 |
|---|---|
| **引用给 Agent，渲染给人** | 工具返回字节区间，不返回猜好的文本；解码是 UI 的事 |
| **Agent 只写规则，不参与打标** | 标记只能由规则脚本产出；Agent 无法在运行时随手标一个点 |
| **重扫由调用方触发** | 不自动重扫；规则改了要重跑就显式跑 |
| **字节优先** | 规则看到的是原始字节流，不是行。变长帧由规则自己切 |

### 21.2 规则契约

规则是一个 ESM 模块，位置 `<workspace>/.serial/rules/<name>/rule.mjs`，同级放 `meta.json`。
规则属于**工作区**：它编码的是这个工程的协议知识，应当跟工程的 git 仓库一起走，而不是留在插件或录制目录里。
解析顺序：`settings.rulesRoot` → `settings.workspaceRoot + '/.serial/rules'` → `process.cwd() + '/.serial/rules'`。

```js
export const meta = { name: 'frame-length-mismatch', version: 1, description: '长度字段与实收不符' }

export function createScanner(ctx) {
  // ctx = { captureId, port, baud }
  let carry = Buffer.alloc(0)
  return {
    record(rec) {   // rec = { t, monoUs, dir: 'rx'|'tx', offset, data: Buffer }
      carry = Buffer.concat([carry, rec.data])
      const marks = []
      while (carry.length >= 4) {
        const declared = carry.readUInt16LE(0)
        if (carry.length < declared + 4) break
        carry = carry.subarray(4 + declared)
      }
      return marks
    },
    finish() { return [] },
  }
}
```

输入记录里的 `offset` 是**该方向流内的绝对字节偏移**，规则可以直接用 `rec.offset + i` 定位，不必自己累加。
字节流没有行概念，是否切行、怎么切，完全由规则决定。

### 21.3 沙箱

规则是 Agent 写的代码，必须假定它可能出错甚至是恶意的。

```
宿主 ──spawn──► node --permission --max-old-space-size=512 -e "<bootstrap>"
                      │  规则源码通过 stdin 传入，子进程零文件权限
                      └─ vm.runInNewContext(源码, { 仅 console })
```

| 层 | 作用 | 实测 |
|---|---|---|
| 子进程 | 崩溃、死循环不影响宿主；到点 kill | 已验证 |
| `--permission`（不给任何 allow） | 文件系统全封 | 读文件返回 `ERR_ACCESS_DENIED` |
| `vm` 上下文 | 不暴露 `process` / `require` / `fetch` | 网络路径被切断 |

**为什么不用 Python**：开箱即用。DSH 宿主自带 Node，用户不需要额外装运行时。
**为什么是子进程而不是进程内 vm**：`node:vm` 不是安全边界，进程隔离才是。

### 21.4 标记结构

```js
{
  id: 'mk-7f3a91',
  rule: 'frame-length-mismatch',
  anchor: { dir: 'rx', offset: 0x20F4, length: 21 },   // 字节区间
  t: 1795164352672,
  kind: 'fault',                 // fault | state | note
  severity: 'error',             // error | warn | info
  label: '长度字段声明 512，超出上限',
  code: { file: 'C:/proj/fw/src/proto.c', symbol: 'parse_frame' },
  hypothesis: '长度字段未做上限校验',
  next: [{ label: '若下一帧仍错 → 缓冲区未复位' }],
  extra: { declared: 512, received: 17 },
}
```

约束：

- `anchor` 只存字节区间，**不存文本**
- `code` **不含行号**（行号随改代码漂移），只有绝对路径 + 符号名
- `id = sha1(rule + dir + offset + label 前 32 字)`，重扫幂等
- 所有路径必须是绝对路径

### 21.5 存储

```
<dataRoot>/<project>/<captureId>.slog                     原始证据，永不修改
<dataRoot>/<project>/<captureId>.marks/<rule>.jsonl       该规则产出的标记
<workspace>/.serial/rules/<name>/rule.mjs                 规则源码（跟工程走）
<workspace>/.serial/rules/<name>/meta.json                规则元信息
```

一条规则一个文件：删文件即撤销该规则的全部标记，互不影响。

### 21.6 接口

| 工具 | 行为 |
|---|---|
| `serial_rules_add` | 装规则；先做语法检查，失败直接拒绝 |
| `serial_rules_list` | 列规则、版本、上次运行的时间与产出条数 |
| `serial_rules_apply` | 解码 `.slog` → 字节流喂给规则 → 收标记 → 写 `.marks/<rule>.jsonl` |
| `serial_marks` | 只返回标记与窗口**引用** |
| `serial_bytes` | 按 `{dir,offset,length}` 取字节，`format` 取 `hex` / `text` / `base64` |

`serial_marks` 返回形态：

```js
{
  marks: [ /* 21.4 的结构 */ ],
  window: { dir: 'rx', offset: 0x1F80, length: 0x1A0 }   // 只给区间，不给内容
}
```

### 21.7 面板

- 侧栏“故障点”：按 severity 分组，显示 `label`、规则名、时间
- 日志区时间轴小旗，颜色对应 severity
- “只看故障点”过滤
- 点击跳到对应字节，按当前断行/编码**解码渲染**
- 展开显示 `code.file` / `code.symbol` / `hypothesis` / `next`

### 21.8 默认值

| 项 | 值 |
|---|---|
| 规则超时 | 20 秒（`timeoutMs` 可覆盖，由调用方判断） |
| 子进程内存 | 512 MB |
| `serial_bytes` 单次上限 | 8 KB，超出截断并标 `truncated` |
| 自动重扫 | **无** |

### 21.9 明确不做

- 不做运行时插入标记（抓取路径保持纯净，只写原始字节）
- 不预置“异常关键词”表（识别规则完全由 Agent 现场定义）
- 不在标记里存行号或文本片段

---

## 22. 状态机中间件（v0.3，规划）

### 22.1 要解决的问题

Agent 一次思考几秒到几十秒，而设备状态机的窗口可能只有几十毫秒。让模型逐字节参与必然错过时序。
所以：**模型当规划者，状态机当执行者**。

### 22.2 形态

- 状态图用 **JSON 声明**（可静态校验、可离线模拟）
- 编解码钩子留 **JS 沙箱**（与 21.3 同一套），v0.3.1 再加
- 事件源只有两个：串口字节、`.slog` 回放；Agent 只负责“换模式 / 启停”
- **离线模拟器为必做项**：同一份脚本先对着录制跑，验证通过再上真机

### 22.3 接口

| 工具 | 行为 |
|---|---|
| `serial_fsm_start` | 加载脚本、校验、进入初始态 |
| `serial_fsm_event` | 注入事件（切换模式） |
| `serial_fsm_wait` | 长轮询：到终态或超时才返回，返回转移轨迹 |
| `serial_fsm_status` | 当前状态、允许的事件、已过时间 |

### 22.4 与故障点的联动

状态机卡在某状态超时 → 自动产出一条 `fault` 标记（走 21.4 的同一结构），
Agent 下次读 `serial_marks` 就能看到“卡在哪一步、当时的字节是什么”，不需要重新抓。
