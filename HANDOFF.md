# 交接：串口插件 v0.3.2

仓库 `D:\文档\杂项\dsh-serial-trigger`，分支 `main`。
先读 `SKILL.md`（模型怎么用这套工具）、`SPEC.md` §14（工具集）与 §23.5（单写者所有权模型）。

## 现在到哪了

- 单测 **144 项全绿**（`node --test --test-force-exit test/*.test.mjs`，约 25 秒）
- 所有权模型（v0.3.1）：模型打开自动接管、旧录制落盘、状态机随端口停、工具身份校验、
  面板只读态 + 被接管跟随（均已在真窗口原生验证）
- v0.3.2 追加：
  - `serial_scan` 可被取消（`exec.signal`），中止后 kill 子进程并返回 `E_SCAN_CANCELLED`；
    顺带修了子进程被杀后 stdin 永不 drain 导致的背压死锁
  - `ownerOf` 兼容宿主传的 Agent 实例 / session id / 空上下文（PTC 嵌套绑定可能什么都不传）
  - `serial_cleanup`：先计划（dryRun）后执行；并修正 `planCleanup` 读错字段导致
    "只清 N 天前"变成"清全部"的隐患
  - `SKILL.md`：模型可读的使用说明

## 工具面（18 个）

ports / open / close / tail / send / captures / grep / export / scan / marks / bytes /
cleanup / fsm_start / fsm_simulate / fsm_event / fsm_wait / fsm_status / fsm_stop

## 下次接手先做

1. 重启桌面端，确认 `serial_cleanup` 出现在工具表里（宿主插件改了就要重启才生效）；
2. 真机冒烟：`node bin/shell-check.mjs COM8`（板子空闲时）；
3. 若要动面板：用 Windows-MCP 在真窗口上验（区域截图，不要整屏 Snapshot，后者 30–75 秒）。

## 约束

- 数据根：桌面配置档里是 `D:/文档/DSH文档库/serial-logs`；重放白名单 `D:/文档/C028/日志`
- 不要修改 `D:\work\git_origin\nrf`（用户与 Codex 的工作区）；板子用完必须 `serial_close`
- 提交走分支 + rebase + `--no-ff`，中文 conventional commits（见 `GIT.md`）
- 第三方客户端包只在桌面端组装，`dsh web` 配置档里没有这个面板

## 还没做的（按优先级）

1. **FSM 超时与失败降级**（P1）：`expect` 等不到回执时的降级策略、超时事件、失败重试边界
2. **FSM 断线重连**（P2）：端口 error/关闭后是否自动重开并恢复状态
3. **触发器编排 v0.4**（待产品决策）：串口触发 → 自动响应的编排层，SPEC 里还没有落地章节
4. 已明确不做：`serial_config` 运行时改配置（改 profile 即可）、状态机多实例并行（设计上一个端口一个）
