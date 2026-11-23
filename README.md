# dsh-serial-trigger

> DSH（DeepSeek Harness）串口助手插件：**无损录制** + 增量读取 + 字节级回查 + 工作区脚本故障点 + 实时状态机中间件。

A DSH plugin for real serial work: lossless `.slog` capture with a SQLite index, incremental `tail`, byte-referenced scan marks from workspace-owned scripts, and a live FSM middleware so the model can plan while the script keeps millisecond timing. 18 model-facing tools plus a web panel. MIT licensed.

## 为什么做这个

模型的一轮思考要几秒到几十秒，而串口设备的时序窗口常常只有几十毫秒。让模型逐字节读串口既慢又不可复现。本插件把三件事分开：

- **实时**：状态机（工作区 JSON 场景）负责收发、超时重试与降级；
- **判定**：扫描脚本（工作区 ESM）事后在录制上找故障点，只产出字节引用；
- **规划**：模型用 18 个工具开端口、抓证据、注入事件、读结论。

所有字节都会落成 `.slog` 并进 SQLite 索引，现场可以用 `captureId` 反复回查。

## 能力

- **端口与录制**：`serial_ports / open / tail / send / close`，一个端口一个写者；工具打开自动接管，面板只读跟随。
- **回查**：`serial_captures / grep / export`，按工程、时间、关键词定位历史录制。
- **故障点**：`serial_scan / marks / bytes`。脚本放在**你的仓库**里（`createScanner(ctx)`），沙箱执行（不能 import、20s 超时、可取消、最多 5000 条），mark 只存 `{dir, offset, length}` 引用。
- **状态机**：`serial_fsm_simulate / start / event / wait / status / stop`。JSON 场景、`line:/regex/` 与 `event:<name>` 两种转换、`send` 必须声明 `expect + waitMs + goto`（不发盲包）、`onTimeout` 支持 retry/goto/mark/severity/stop、状态级 `after` 定时器、一端口一机器、可先对着录制离线 simulate。
- **面板**：`client/client.js`（Web），实时流、统计、标记、只读/接管状态。
- **归属与清理**：录制区分 `origin=agent|human`；模型工具**不能删除录制**（`serial_cleanup` 只读）；用户归档会话时其录制才被删除。

## 安装（DSH）

本包是 DSH 插件（bundle patch + web client），不依赖额外构建步骤。

1. 安装到 DSH profile（示例，具体以你的 profile 包管理器为准）：

   ```bash
   pnpm add dsh-serial-trigger
   ```

   本地开发时可以 `link:` 指向工作副本。

2. 在 profile 的 `cordis.patch.yml` 里挂载（包内 `cordis.patch.yml` 是相对路径版，npm 安装后直接用包名）：

   ```yaml
   - insert:
       - id: serial-trigger
         name: 'dsh-serial-trigger'
     config:
       dataRoot: 'D:/serial-logs'
   ```

3. 重启 DSH。客户端插件按 `package.json` 的 `dsh.client` 声明自动注册。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `~/.dsh/serial-trigger/data` | 录制根目录（`.slog` + `index.db`） |
| `replayRoots` | `[]` | 允许回放的文件目录白名单 |
| `ringBytes` | 8 MiB | 内存字节环大小（tail/订阅的实时窗口） |
| `archivePollMs` | 2000 | 归档列表轮询间隔（归档即清录制） |
| `workspaceRoot` / `scanRoots` | 宿主进程工作目录 | 扫描脚本与 FSM 场景的允许根 |
| `dshHome` | `$DSH_HOME` | 桌面端归档列表位置（`storages/workspace.json`） |

## 快速上手

给模型用：加载 `SKILL.md`（或 DSH 的 `skill` 工具），按里面的四条工作流走。最小链路：

```js
serial_ports
serial_open({ port: 'COM8', project: 'bringup' })   // → portId, captureId
serial_tail({ portId, timeoutMs: 3000 })            // → 新行 + cursor
serial_send({ portId, text: 'PING', append: 'lf' })
serial_close({ portId })                            // 落盘 + 索引
```

给维护者：完整工具说明见 `SKILL.md`；设计/交接/测试计划文档不随发布包分发。

## 开发

```bash
npm test                              # 169 项单测（约 27s）
node bin/shell-check.mjs COM8         # 真机字节透明/句柄/索引冒烟（7 项）
node bin/rules-check.mjs COM8         # 扫描/标记/字节引用/沙箱守卫（12 项）
node bench/lag.mjs 50                 # 吞吐/延迟基准
```

## 数据与隐私

- 录制只写本机 `dataRoot`，不上传；
- 扫描脚本、FSM 场景由用户仓库管理，插件不保存、不注册；
- 删除录制不是模型能发起的动作。

## 边界

- 没有通用触发器/自动唤醒：实时响应交给状态机，事后判定交给扫描脚本；
- 不做运行时配置工具，配置走 profile；
- 掉线不自动重连，需重新 `serial_open`。

## License

[MIT](./LICENSE) © 2026 luochaozheng
