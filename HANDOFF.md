# 交接：串口插件 v0.3.9

仓库 `D:\文档\杂项\dsh-serial-trigger`，分支 `main`。
先读 `SKILL.md`（模型怎么用）、`SPEC.md` §11.1（谁录的谁来清）、§22.6（超时与失败降级）、§23.5（单写者）。

## 现在到哪了

- 单测 **167 项全绿**（`node --test --test-force-exit test/*.test.mjs`，约 26 秒）
- 真机冒烟通过（2026-11-22，COM8，板子空闲）：`bin/shell-check.mjs` 7/7（字节透明 sha256 一致、
  seq 无洞、句柄 2→2、索引 11 行）、`bin/rules-check.mjs` 12/12（扫描/标记/字节引用/越界与超时守卫）
- 工具 **18 个**（含 `serial_cleanup`）
- `SKILL.md` 已升级到 v0.3.6：18 个工具、FSM 场景语法、扫描脚本契约、归属与归档、错误码速查（给 agent 的唯一用法说明）
- 工具结果必须是宿主可接受的 **lossless JSON**（不允许 undefined / NaN / -0 / Buffer 等），新测试 `test/tool-output.test.mjs` 守住这个边界
- v0.3.3 之前：单写者模型、面板只读/接管跟随（真机验过）、可取消扫描、工具身份兼容、
  录制清理工具、SKILL.md
- v0.3.3 / v0.3.4：
  - **录制归属**：captures 增加 `origin`（agent / human）。工具开的记 agent，面板开的记 human；
    `serial_cleanup` 只返回计划（只读），**删除不是模型能发起的动作**（传 planId → `E_READ_ONLY`）；
    人的录制永不自动删除，删除能力只留在 `Store.applyCleanup` 供将来的自动保留策略用
  - **FSM 超时策略可配置**：转换上可写 `onTimeout: { retry, retryDelayMs, goto, mark, severity, stop }`；
    不写时行为不变；离线 simulate 同样生效
  - live 循环原来只在"有状态转移"时才 drain 副作用，超时重发/停机这类无转移的动作会被吞掉，已修
  - **归档即清**：对话归档时删除该会话产生的所有录制（先关端口再删，宿主退出不删，单文件 5 秒超时）；工具调用通过 session/event 的 callId 映射拿到会话身份（src/identity.mjs），工具开的端口现在归会话所有
- v0.3.5（修复）：
  - **归档触发方式修正**：桌面端归档只往 `$DSH_HOME/storages/workspace.json` 的
    `global.archivedSessionIds` 追加 id，**不 dispose 会话**，所以 v0.3.4 订阅的
    `session/disposed` 在归档时从不触发（实测 session-cd58a9c5 归档后，录制、索引行都在，
    日志里 held back capture / cannot subscribe 零命中）。现改为观察该列表：挂载对账一次 +
    每 2 秒轮询新归档；`session/disposed` 保留给关闭/退出路径（SPEC 11.2）
- v0.3.6（盲跑验收修复）：
  - 用独立 subagent 只读 SKILL.md 盲跑 L1 抓包→L2 扫描脚本→L3 FSM：任务最终能做完（101 次工具调用 / 16.5 分钟），但探出 3 个接口缺陷：
  - **grep 有命中即失败**：`store.grep` 给 LineAssembler 的 batch 没有 `seq`，hits 里 `seq=undefined`，
    宿主判 "not lossless JSON" 整个结果报废；decode-lines（`serial_capture` 面板视图 / simulate 读行）同病，已修
  - **simulate 带 mark 即失败**：marks 里 `extra: undefined` 同类报废；已改为字段缺省不携带
  - **子 agent 会话 dispose 误删录制**：v0.3.4 起 `session/disposed` 会删该会话录制，而委派 subagent 结束就会 dispose，
    于是父会话证据被静默删除（盲跑实测：trial 的 4 条录制 + 索引行消失）。已改为 **dispose 只收尾、不删录制**，
    删除只由归档触发（L5 测试改写）
  - 附带：`trace.via` 行匹配曾输出 `line:line:/re/`，已去重；SKILL 补了工作区根、grep 返回结构、
    seq 语义（字节偏移）、`next[]` 对象结构、发送行尾/回显、close 可能慢、simulate 不能注入 event 等 11 处说明

- v0.3.7（第二轮盲跑修复）：
  - 盲跑第 2 遍（独立 subagent，只读 SKILL.md）：L1/L2/L3 全部通过（98 次调用 / 15 分 20 秒），
    接口层不再出现 invalid output；暴露 2 个代码缺陷 + 4 个说明书缺口：
  - **扫描脚本返回单个 mark 对象即 E_SCAN_FAILED**（marks is not iterable）：sandbox-child 迭代了对象；
    已改为数组或单对象都接受，并补 S9 单测
  - **simulate 时钟错误**：机器从 t=0 起算、tailMs 从第一条录制算，导致 initial 态的 after 在首行就触发、
    tailMs 无法覆盖录制结束之后；已锚定第一条录制、tailMs 改为从最后一条起算，补 F8 单测
  - 说明书补：E_SCAN_FAILED、工作区根的两种错误（含相对路径按宿主 cwd 解析）、after 自环会重置计时、
    tailMs 语义、scan 返回 marks 是数量、bytes 越过文件尾会截断
  - 错误 hint 改进：E_NO_SUCH_SCRIPT / E_SCRIPT_OUTSIDE_WORKSPACE / E_SCENARIO_OUTSIDE_WORKSPACE
    现在直接给出允许根目录（不再提不存在的 serial_config）

- v0.3.8（第三轮盲跑修复）：
  - 盲跑第 3 遍（独立 subagent，只读 SKILL.md）：L1/L2/L3 全通过（约 40 次工具调用 / 9 分钟），
    比第 2 遍（98 次 / 15 分钟）明显收敛；暴露 2 个代码缺陷、若干说明书细节：
  - **`scenario: {path}` 直接 E_INTERNAL: stat is not defined**：loadScenario 用了 readFile/stat 但没 import；已修 + R8 单测
  - **simulate 尾部只推进一跳**：链式 after（A→B→C 各 1s）在 tailMs 窗口里只触发第一跳；已改为按定时器
    deadline 连续推进到窗口关闭 + F9 单测
  - 说明书补：脚本要写 ESM `export`、`persisted` 含义、省略 cursor 的实际回看范围、anchor length=0 语义、
    tailMs 内链式定时器、E_INTERNAL、场景文件路径按宿主 cwd 解析

- v0.3.9（第四轮盲跑修复，SKILL 验收收官）：
  - 盲跑第 4 遍（独立 subagent，只读 SKILL.md）：L1/L2/L3 全通过（44 次调用 / 10 分 44 秒），
    且用上了前几轮修好的能力（scene {path}、单个 mark、E_BAD_SCENARIO、persisted）；只暴露说明书表述问题：
  - **serial_bytes.truncated 语义反了**：实现是「读满请求长度」而非「到文件尾」；已改为后者（文件到尾返回短于 length 时为 true），
    tools 描述与 O5 单测同步
  - 说明书补：工具失败返回 {ok:false,error{...}} 外壳、status.events/lines 含义、simulate 无 status、mark.code 可选语义、
    **line 转换每匹配一行触发一次（别把 send+expect 挂在重复行上）**、captures 的 truncated/missing 字段
  - 四轮缺陷收敛：3 个接口缺陷（grep/simulate 报废、误删录制）→ 2 个（单 mark、simulate 时钟）→ 2 个（场景文件、链式定时器）→ 0 个代码缺陷

## SKILL 验收协议（以后改 SKILL 就照这个跑）

1. 起一个独立 subagent（新上下文），只给它：`读 SKILL.md` + COM8 可用 + 三档任务；
   **禁止**读 SPEC/src/test/git 历史，卡住只能记缺陷、不许猜源码；
2. 三档任务：L1 抓包（open+tail×2+captures+grep）→ L2 扫描脚本（写脚本→scan→marks→bytes 验引用）
   → L3 FSM（simulate→live→event→wait→status→stop，且必须故意造一次错并自愈）；
3. 判定：L1/L2/L3 全过 + 结束无 open 端口 + 交付「SKILL 缺陷清单」；有缺陷按「代码 bug / 文档没说 / 环境」归类；
4. 稳定性：同一提示词连跑 2–3 次（真机单写者，必须串行），看调用次数与缺陷数是否收敛；
5. 只改可归因到 SKILL 的句子；代码 bug 单独修并加回归测试，**不要用说明书去掩盖 bug**。

- **v0.3 定档**（v0.3.5）：v0.3 线自此只修缺陷，不再加功能；v0.4 改为**可做可不做**的窄扩展，
  定义见 SPEC §24

## 已知问题（P1，下次先看）

- **归档删除已在真实宿主验过**（2026-11-22 重启后）：新会话 `session-f5219aa8` 用工具录了一条
  `MOCK-E2E-20261122-221045`，在侧栏「归档会话」后约 2 秒，宿主日志出现
  `serial-trigger: removed 1 recording(s) of an archived conversation session-f5219aa8-…`，
  `.slog` 与索引行同时消失。挂载对账路径由单测 L7 覆盖。
- 两条测试会话（`串口发送消息并关闭`、`串口打开关闭操作测试`）已清理：录制（.slog + 索引行）、
  会话目录、session 缓存都删了；`workspace.json` 的 `archivedSessionIds` 与工作区 `sessionIds`
  已不再引用它们（数据根只剩两条历史 COM8 人工录制）。当前 App 列表里还能看到这两行，是宿主内存
  里的旧快照——实测宿主退出时不回写存储文件，**重启后已确认列表干净**。

## 下次接手先做

1. **让 v0.3.6 生效**：改动只在新进程里加载，需重启宿主（或可先试 profile 配置 touch 触发重载）。
   重启后跑 2 次"只读 SKILL.md 盲跑"（同 turn 的 trial-1 提示词）验证稳定性；
2. 没有排期项；v0.4 可选（SPEC §24），动手前先确认真要投入；
2. 动面板用 Windows-MCP + 区域截图（整屏 Snapshot 30–75 秒，太慢）。
## 约束

- 数据根：`D:/文档/DSH文档库/serial-logs`；重放白名单 `D:/文档/C028/日志`
- 不要修改 `D:\work\git_origin\nrf`；板子用完必须 `serial_close`
- 提交走分支 + rebase + `--no-ff`，中文 conventional commits（见 `GIT.md`）

## 还没做的

1. **v0.4（可选）**：FSM 故障态唤醒对话，见文末与 SPEC §24
2. 断线重连（P2，用户认为场景少，暂不做）
3. 删除偶发挂起（P2，本机现象；已用单文件 5 秒超时兜底，归档删除实测正常）
4. M10 故障注入 + 黄金轨迹（测试基建 backlog，无排期）
5. 已明确不做：运行时改配置的 `serial_config`、状态机多实例并行、通用触发器引擎/编辑器

## v0.4（已定义，可做可不做）

> FSM 的状态触发模型的对话，作为故障状态处理的一环。——完整契约见 SPEC §24。

- 触发：场景里声明的状态（故障 / 停机 / 自定义）进入时，向该 FSM 所属会话投递一条结构化消息
  （端口与 runId、状态、最近转移轨迹、mark 与字节引用），并用 `agent.followup` 唤醒一轮对话；
- 处理仍由模型用现有工具完成（读 marks/bytes、重发、改场景），插件不新增自动发送能力；
- 去重与预算：同一 `(runId, state)` 只唤醒一次，每次 run 上限 1–3 次；端口被接管/关闭、
  会话归档时不唤醒；模型正忙时排队不打断；
- **不做**：通用触发器引擎（行级规则/编排层/`serial.trigger`/`captures.triggers`）、
  触发器编辑器、M10 故障注入+黄金轨迹（移测试基建 backlog）；
- 实现前**不要**补 SKILL.md（写了模型会以为能用）；实现那次一起补。
- 开放细节（实现时定）：场景字段名、`source.kind` 取值、stop 是否也唤醒、唤醒目标是否总是发起会话。
