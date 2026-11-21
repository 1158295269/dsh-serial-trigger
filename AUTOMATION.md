# 自动化测试规划

目标：改完不用人工点一遍。分四层，从便宜到贵，频率递减。

## 第 1 层：单元与集成（每次提交）

```bash
node --test --test-force-exit test/*.test.mjs
```

- 现在 119 项，跑 20 秒左右
- 覆盖：容器编解码、hub 背压、断行策略、索引与导出、扫描脚本沙箱、所有权、生命周期
- **门槛**：合并前必须全绿

## 第 2 层：真机冒烟（有硬件时，每次合并）

```bash
node bin/shell-check.mjs COM8        # 字节透明、tap 不依赖订阅者、开合不泄漏
node bin/rules-check.mjs COM8        # 扫描脚本、越界守卫、死循环超时
```

固件只需要持续吐字节，不校验协议。**没有硬件时跳过，并在提交信息里注明"未验真机"。**

## 第 3 层：界面自动化（新增，重点）

现在所有界面问题都是靠你截图发现的：面板撑破容器、标签没出现、所有权没生效。这些都能脚本化。

### 方案：CDP 驱动真实浏览器

```
test/ui/
  run.mjs            启动隔离实例 + 无头 Chrome，跑场景
  page.mjs           CDP 封装：click / text / eval / screenshot / waitFor
  scenarios/
    view-tab.mjs     标签出现、切换后会话不丢
    layout.mjs       面板高度 == 容器高度（防止再次撑破）
    ownership.mjs    会话 A 开端口，会话 B 看到"被占用"、发送被拒
    lifecycle.mjs    归档会话 A 后端口释放
    history.mjs      打开录制 → 故障点 → 导出
```

每个场景是一个函数，失败时输出：截图 + DOM 片段 + 当前 /serial/state。

### 关键断言示例

```js
// layout.mjs —— 这条能直接抓住刚才那个"撑破容器"的 bug
const { root, host } = await page.eval(() => ({
  root: document.querySelector('.sst-root').getBoundingClientRect().height,
  host: document.querySelector('.sst-root').parentElement.clientHeight,
}))
assert.ok(Math.abs(root - host) <= 2, `面板高 ${root} vs 容器 ${host}`)

// ownership.mjs
await page.click('.sst-port:has-text("COM8")')       // 会话 A 打开
await page.switchSession('session-b')
assert.match(await page.text('.sst-port'), /被占用/)
assert.equal(await page.isDisabled('.sst-send'), true)
```

### 会话切换怎么自动化

两个办法，从简到繁：

1. **两个浏览器标签页**，各自绑定不同会话（最贴近真实）
2. 用宿主 HTTP 接口创建会话，再用 URL 打开（需要确认 DSH 有没有创建会话的公开接口）

先做办法 1：同一个实例开两个标签页，各点不同会话。

### 视觉回归

关键界面存基线截图，用像素差 > 2% 判定失败：

```
test/ui/baseline/view-tab.png
test/ui/baseline/panel.png
test/ui/baseline/hex.png
test/ui/baseline/stats.png
```

不追求逐像素一致（字体渲染有差异），只看布局是否明显变化。

## 第 4 层：长时间稳定性（每周或大改后）

```bash
node bench/soak.mjs          # 30 分钟持续写入，看内存与文件一致性
node bench/lag.mjs 200       # 200MB 录制，量各操作的事件循环卡顿
```

判定：RSS 增长 < 10%、无数据丢失、单次卡顿 < 100ms。

---

## 执行矩阵

| 层 | 触发时机 | 时长 | 失败后果 |
|---|---|---|---|
| 1 单元 | 每次保存/提交 | 20s | 不允许提交 |
| 2 真机 | 合并前（有硬件） | 30s | 不允许合并 |
| 3 界面 | 改前端或宿主交互后 | 2–3 分钟 | 阻塞合并 |
| 4 稳定性 | 每周 | 30 分钟 | 记录，不阻塞 |

## 现在要补的三件事

1. `test/ui/` 骨架 + `layout` 与 `view-tab` 两个场景（能立刻防住已发生的两类回归）
2. `ownership` 场景：双标签页 + 两个会话
3. `npm scripts`：`test`、`test:ui`、`test:hw`，让三条命令记得住

## 不做什么

- 不做 mock DOM 的组件测试：面板的问题几乎都出在"和宿主容器的关系"上，脱离真实宿主测不出来
- 不追求 100% 覆盖率：当前 116 项测试已经覆盖了容易出错的状态机与边界
