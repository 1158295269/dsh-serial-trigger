# dsh-serial-trigger

[English](README.md) · [更新日志](CHANGELOG.md) · [文档目录](docs/README.md) · MIT

DSH（DeepSeek Harness）串口助手插件：**无损录制** + 增量读取 + 字节级回查 + 工作区扫描脚本（只产出字节引用）+ **实时 FSM 中间件**。模型负责规划，脚本负责毫秒级时序。18 个模型工具、会话内面板，MIT 许可。

## 为什么做这个

模型一轮思考要几秒到几十秒，而串口设备的时序窗口常常只有几十毫秒。让模型逐字节读串口既慢又不可复现。本插件把三件事分开：

| 层 | 由谁负责 | 职责 |
|---|---|---|
| 实时 | **FSM**（工作区 JSON 场景） | 发送 / 等回执 / 重试 / 超时降级 |
| 判定 | **扫描脚本**（工作区 ESM，可反复重扫） | 在录制上找故障点，只产出字节引用 |
| 规划 | **模型** | 开端口、抓证据、注入事件、读结论 |

所有字节都会落成 `.slog` 并写入 SQLite 索引，一个 `captureId` 可以反复回查——上下文压缩后、下周、换台机器都行。

## 能力

- **端口与录制**：`serial_ports / open / tail / send / close`。一个端口一个写者；工具打开自动接管，面板只读跟随。
- **历史回查**：`serial_captures / grep / export`。按工程、时间、关键词找回现场；导出 text / hex / csv，不改源文件。
- **故障点**：`serial_scan / marks / bytes`。脚本放在**你的仓库**（`createScanner(ctx)`），mark 只存 `{dir, offset, length}` 引用。沙箱执行：不能 import、默认 20s 超时、可取消、最多 5000 条。
- **实时 FSM**：`serial_fsm_simulate / start / event / wait / status / stop`。`line:/正则/` 与 `event:<name>` 两种转换；写了 `send` 必须声明 `expect + waitMs + goto`（不发盲包）；`onTimeout` 支持 retry / goto / mark / severity / stop；状态级 `after` 定时器；一端口一机器；上真机前可先对着录制离线 `simulate`。
- **面板**：会话里的 `串口` 标签页——实时终端、RX/TX 过滤、搜索、断行策略、发送框、统计、历史、标记、接管提示。
- **归属与清理**：录制分 `origin=agent|human`；模型**不能删除录制**（`serial_cleanup` 只读）；只有用户归档会话时其录制才会被删。

## 安装

要求：DSH 桌面端（在 `0.2.1-rc.2` 上测过）、Node.js ≥ 24、你的 USB 串口适配器驱动。

1. 装进 DSH profile：

   ```bash
   cd "$DSH_HOME/profiles/desktop"      # 要让哪个 profile 加载
   pnpm add dsh-serial-trigger
   # 本地开发：
   pnpm add link:/path/to/dsh-serial-trigger
   ```

2. 重启 DSH。包里的 `dsh.bundle.patch` 会让宿主挂载 `serial-trigger`，`dsh.client` 声明的面板会自动注册。

3. 可选：在 profile 的 `cordis.patch.yml` 里覆盖配置（同 id 的行会合并）：

   ```yaml
   - id: serial-trigger
     config:
       dataRoot: 'D:/serial-logs'
       replayRoots:
         - 'D:/device-logs'
   ```

4. 验证：在 DSH 对话里应能看到 `串口` 标签，或让 agent 调一次 `serial_ports`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `~/.dsh/serial-trigger/data` | 录制根（`.slog` + `index.db`） |
| `replayRoots` | `[]` | 允许回放进 mock 端口的目录 |
| `ringBytes` | 8 MiB | `tail` 与实时订阅用的内存字节环 |
| `archivePollMs` | 2000 | 归档会话列表轮询间隔（归档会删该会话录制） |
| `workspaceRoot` | 宿主进程工作目录 | 扫描脚本与 FSM 场景的兜底根 |
| `scanRoots` | `[workspaceRoot]` | 扫描脚本/场景的显式允许列表 |
| `rulesRoot` | `<workspaceRoot>/.serial/rules` | 规则脚本的约定目录 |
| `dshHome` | `$DSH_HOME` | 桌面端归档列表所在根 |

## 快速上手

工具返回统一外壳：成功 `{ok:true, data:{…}}`，失败 `{ok:false, error:{code, message, hint, fix[], retryable}}`。

```js
serial_ports                                            // → ports[]
serial_open({ port: 'COM8', project: 'bringup' })       // → { portId, captureId, path }
serial_tail({ portId, timeoutMs: 3000 })                // → { lines[], cursor }
serial_send({ portId, text: 'PING', append: 'lf' })
serial_close({ portId })                                // → { path, bytesRx, bytesTx, lines }
```

事后找回：

```js
serial_captures({ project: 'bringup', keyword: 'timeout' })
serial_grep({ captureId, pattern: 'ASSERT', context: 3 })
serial_export({ captureId, format: 'text' })
```

## FSM 一眼看懂

```json
{
  "name": "handshake",
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
                         "mark": "no echo", "severity": "warn" }
        },
        "line:/^READY/": { "goto": "ready" }
      },
      "after": { "ms": 5000, "goto": "recovering", "mark": "no output" }
    },
    "ready": { "on": {} },
    "linked": { "on": {} },
    "recovering": { "on": {} }
  }
}
```

先 `serial_fsm_simulate` 对着录制离线验证（不碰端口、不发送），再 `serial_fsm_start` 真机跑；`serial_fsm_event` 注入事件，`serial_fsm_wait` 长轮询下一次转移，`serial_fsm_stop` 落盘标记。完整语法见 [docs/fsm.md](docs/fsm.md)。

## 扫描脚本一眼看懂

```js
// hb-scan.mjs —— 必须放在插件的工作区根下（见文档）
export function createScanner(ctx) {
  return {
    record({ t, dir, offset, data }) {
      if (dir !== 'rx') return null;
      // ... 解析行，返回单个 mark 或 mark 数组
      return { anchor: { dir: 'rx', offset, length: data.length }, t, kind: 'state',
               severity: 'info', label: 'HB ' + data.length + ' bytes' };
    },
    finish() { return null; },
  };
}
```

`serial_scan({ captureId, script }) → serial_marks({ captureId }) → serial_bytes({ captureId, dir, offset, length })`。mark 只存引用不带文本。完整契约见 [docs/scanning.md](docs/scanning.md)。

## 数据、归属与隐私

- 录制只写本机 `dataRoot`，不上传。
- 一个端口一个写者：工具 `serial_open` 会自动接管（对方正常收尾）；非持有者只能 `serial_tail` 只读，写入/关闭得 `E_NOT_OWNER`。
- 模型不能删除录制；只有用户归档会话时该会话录制才会被删；面板里人自己开的录制永不自动删。
- 扫描脚本与 FSM 场景就是工作区里的普通文件，由你的 git 管理；沙箱禁止 import、限制文件读取，但仍应把它们当自己的代码对待。

## 兼容性

- DSH 桌面端：在 `0.2.1-rc.2` 上测过（`engines.dsh`）。
- Node.js ≥ 24。
- 系统：Windows 10/11 做过真机验证；`serialport` 13 也支持 macOS/Linux（本仓库测试未覆盖）。`MOCK:<name>` 端口不需要硬件。

## 开发

```bash
npm test                              # 170 项单测（约 30s）
node bin/shell-check.mjs COM8         # 真机门禁：字节透明/句柄/索引（7 项）
node bin/rules-check.mjs COM8         # 扫描/标记/字节引用/沙箱守卫（12 项）
node bench/lag.mjs 50                 # 吞吐/延迟基准
```

约定与评审清单见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档目录

- [docs/tools.md](docs/tools.md) —— 18 个工具的参数、返回、错误
- [docs/fsm.md](docs/fsm.md) —— FSM 场景语法与常用模式
- [docs/scanning.md](docs/scanning.md) —— 扫描脚本契约、标记、沙箱
- [docs/configuration.md](docs/configuration.md) —— 配置、数据布局、归档语义
- [docs/panel.md](docs/panel.md) —— 面板日常使用
- [docs/architecture.md](docs/architecture.md) —— 给贡献者的内部结构
- [docs/troubleshooting.md](docs/troubleshooting.md) —— 错误码与常见问题
- [SKILL.md](SKILL.md) —— 给模型看的精简手册

## 路线与边界

- 没有通用触发器，也不在故障态自动唤醒模型（可选扩展，尚未实现）；
- 掉线不自动重连，需重新 `serial_open`；
- 运行时改配置需要重启 DSH（配置来自 profile）。

## 许可证

[MIT](LICENSE) © 2026 luochaozheng
