# 交接：串口插件 v0.3.5

仓库 `D:\文档\杂项\dsh-serial-trigger`，分支 `main`。
先读 `SKILL.md`（模型怎么用）、`SPEC.md` §11.1（谁录的谁来清）、§22.6（超时与失败降级）、§23.5（单写者）。

## 现在到哪了

- 单测 **158 项全绿**（`node --test --test-force-exit test/*.test.mjs`，约 26 秒）
- 真机冒烟通过（2026-11-22，COM8，板子空闲）：`bin/shell-check.mjs` 7/7（字节透明 sha256 一致、
  seq 无洞、句柄 2→2、索引 11 行）、`bin/rules-check.mjs` 12/12（扫描/标记/字节引用/越界与超时守卫）
- 工具 **18 个**（含 `serial_cleanup`）
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

1. v0.4 触发器编排的决策（清单见文末；这是当前唯一的排期项）；
2. 动面板用 Windows-MCP + 区域截图（整屏 Snapshot 30–75 秒，太慢）。
## 约束

- 数据根：`D:/文档/DSH文档库/serial-logs`；重放白名单 `D:/文档/C028/日志`
- 不要修改 `D:\work\git_origin\nrf`；板子用完必须 `serial_close`
- 提交走分支 + rebase + `--no-ff`，中文 conventional commits（见 `GIT.md`）

## 还没做的

1. **触发器编排 v0.4**（待产品决策，见文末清单）：串口触发 → 自动响应的编排层
2. 断线重连（P2，用户认为场景少，暂不做）
3. 删除偶发挂起（P2，本机现象；已用单文件 5 秒超时兜底，归档删除实测正常）
4. 已明确不做：运行时改配置的 `serial_config`、状态机多实例并行
