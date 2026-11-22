# 交接：串口插件 v0.3.6

仓库 `D:\文档\杂项\dsh-serial-trigger`，分支 `main`。
先读 `SKILL.md`（模型怎么用）、`SPEC.md` §11.1（谁录的谁来清）、§22.6（超时与失败降级）、§23.5（单写者）。

## 现在到哪了

- 单测 **163 项全绿**（`node --test --test-force-exit test/*.test.mjs`，约 26 秒）
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
