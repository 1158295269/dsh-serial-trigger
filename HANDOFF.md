# 交接：串口插件 v0.3.3

仓库 `D:\文档\杂项\dsh-serial-trigger`，分支 `main`。
先读 `SKILL.md`（模型怎么用）、`SPEC.md` §11.1（谁录的谁来清）、§22.6（超时与失败降级）、§23.5（单写者）。

## 现在到哪了

- 单测 **151 项全绿**（`node --test --test-force-exit test/*.test.mjs`，约 26 秒）
- 工具 **18 个**（含 `serial_cleanup`）
- v0.3.3 之前：单写者模型、面板只读/接管跟随（真机验过）、可取消扫描、工具身份兼容、
  录制清理工具、SKILL.md
- v0.3.3 本次：
  - **录制归属**：captures 增加 `origin`（agent / human）。工具开的记 agent，面板开的记 human；
    `serial_cleanup` 只返回计划（只读），**删除不是模型能发起的动作**（传 planId → `E_READ_ONLY`）；
    人的录制永不自动删除，删除能力只留在 `Store.applyCleanup` 供将来的自动保留策略用
  - **FSM 超时策略可配置**：转换上可写 `onTimeout: { retry, retryDelayMs, goto, mark, severity, stop }`；
    不写时行为不变；离线 simulate 同样生效
  - live 循环原来只在"有状态转移"时才 drain 副作用，超时重发/停机这类无转移的动作会被吞掉，已修

## 已知问题（P1，下次先看）

- **`serial_cleanup` 执行阶段会挂住**：plan 正常返回（列出了 12 条测试录制），
  传 planId 之后调用 120 秒不返回，且一条都没删。怀疑与这台机器上"删除文件"的怪现象有关
  （`Remove-Item`、`rm -r` 在某些目录也会卡住，之前清理 `~/.dsh/cache` 同样卡）。
  下一步：在 `store.deleteCapture` 加超时/重试与分步日志，先定位卡在 `rm` 还是 SQLite。

## 下次接手先做

1. 查上面的 cleanup 挂起（复现：`serial_cleanup({project:'ui-check'})` 拿 planId → apply）；
2. 真机冒烟：`node bin/shell-check.mjs COM8`（板子空闲时）；
3. 动面板用 Windows-MCP + 区域截图（整屏 Snapshot 30–75 秒，太慢）。

## 约束

- 数据根：`D:/文档/DSH文档库/serial-logs`；重放白名单 `D:/文档/C028/日志`
- 不要修改 `D:\work\git_origin\nrf`；板子用完必须 `serial_close`
- 提交走分支 + rebase + `--no-ff`，中文 conventional commits（见 `GIT.md`）

## 还没做的

1. **cleanup 挂起**（P1，见上）
2. **触发器编排 v0.4**（待产品决策）：串口触发 → 自动响应的编排层
3. 断线重连（P2，用户认为场景少，暂不做）
4. 已明确不做：运行时改配置的 `serial_config`、状态机多实例并行
