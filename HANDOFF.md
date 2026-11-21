# 交接：串口插件 v0.3.1

仓库 `D:\文档\杂项\dsh-serial-trigger`，分支 `main`，标签 `v0.3.1`。
先读 `SPEC.md` §23.5（单写者所有权模型）与 `GIT.md`（提交规范）。

## 这一版做了什么

单写者模型落地（SPEC §23.5.1）：

1. **模型自动接管**：`SerialService.open` 新增 `autoTakeover`；工具 `serial_open` 固定开启，
   被顶掉的端口先 `close(force, reason:'takeover')`，对方的录制正常收尾落盘。
2. **状态机随端口结束**：`close()` 之前先 `_stopRunsForPort`，机器不会挂在死环上继续跑。
3. **工具带身份**：`serial_open` / `serial_send` / `serial_close` 传 `{kind:'agent', id:exec.agent}`，
   子 agent 沿用父身份；非持有者写入或关闭得到 `E_NOT_OWNER`，不再静默生效。
4. **面板只读态**：点他人端口 = 只读观看（不弹确认、不抢写），发送框禁用，
   标签「只读 · 由 Agent 持有」；要写必须点「接管写入」。
5. **被接管可感知**：自己的 portId 消失且同名端口换了主人时，自动跟到新 portId，
   标签「已被接管 · 只读」，读数不中断；只读态不渲染状态机事件按钮。

## 验证到哪一步

- 单测 **138 项全绿**（`node --test --test-force-exit test/*.test.mjs`，约 25s）
  - 新增 O 组：`test/port-busy.test.mjs` B1–B4（接管、旧录制落盘、旧句柄失效、机器随端口停止、工具身份）
  - `test/e2e.test.mjs` 的"重复 open"用例改为断言接管成功
- `node --check client/client.js` 通过
- 界面自动化脚本已补 `test/ui/run.mjs` S9（只读）/ S10（被接管跟随），**尚未执行**：
  面板改动要宿主重启后才能加载，而重启会结束当前会话。

## 下次接手先做

1. 重启 DSH（桌面端），确认「串口」标签在，点一个被 Agent 占用的端口 → 只读态；
2. 跑界面自动化：
   `node test/ui/run.mjs --base <url> --token <token> --only readonly`（再跑 `--only taken-over`）
3. 真机冒烟（有板子时）：`node bin/shell-check.mjs COM8`

## 现状与约束

- 版本：`package.json` 0.3.1；已合并状态机中间件（v0.3.0）与所有权模型。
- 数据根：桌面配置档里是 `D:/文档/DSH文档库/serial-logs`；重放白名单 `D:/文档/C028/日志`。
- 不要修改 `D:\work\git_origin\nrf`（用户与 Codex 的工作区）；板子用完必须 `serial_close`。
- 提交走分支 + rebase + `--no-ff`，中文 conventional commits（见 `GIT.md`）。
- 隔离 UI 实例：`dsh web --profile serialui --no-open --port 51987`；但第三方客户端包在
  `dsh web` 配置档里不会被装进 `__DSH_BOOT__`（只有桌面端会），所以界面验证要在桌面实例上做。

## 还没做的（按优先级）

1. 面板只读态的界面回归（上面第 1、2 条）
2. 闲时租约：agent 忘了关的端口按 `idleForMs` 自动释放（`reapIdle` 已有雏形）
3. `exec.signal` 取消 `serial_scan` 子进程
4. 触发器编排（v0.4）与 FSM 剩余能力（v0.3 计划里未实现的部分）
5. `SKILL.md`：把"怎么用这套工具"写成模型可读的技能
