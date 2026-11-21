# Git 维护规则

本文件是硬性约定，不是建议。每次提交前对照一遍。

---

## 1. 提交信息格式：约定式提交（中文）

```
<type>(<范围>): <一句话说清做了什么>

<正文：为什么这么改，放弃过什么方案>
```

`type` 只能用下面这 7 个，其它一律不允许：

| type | 用于 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `docs` | 文档 |
| `test` | 测试用例、测试脚本 |
| `refactor` | 不改外部行为的重构 |
| `perf` | 性能优化 |
| `chore` | 依赖、构建、合并、杂务 |

`范围` 用中文，取自固定词表，不要自创：

| 范围 | 覆盖 |
|---|---|
| `串口助手` | 插件整体、版本节点 |
| `采集` | codec、hub、断行、录制 |
| `服务` | 端口生命周期、service、串口适配 |
| `索引` | SQLite、grep、导出、恢复 |
| `面板` | client/client.js 及样式 |
| `工具` | tools.mjs 的 agent 接口 |
| `测试` | 用例、测试脚本 |
| `文档` | SPEC、TESTPLAN、GIT、README |
| `构建` | package.json、依赖、打包 |
| `合并` | 合并提交专用 |

正例：

```
feat(面板): 增加只读历史视图
fix(索引): 修正跨项目 id 冲突
docs(文档): 采用约定式提交格式
test(采集): 补充分帧策略边界用例
chore(构建): 升级 serialport 到 13.0.1
chore(合并): 合并 Git 维护规则
```

反例（禁止）：

```
fix
update
修改
串口助手：首个版本          ← 缺 type
feat: 增加面板              ← 缺范围
Feat(面板): 增加面板         ← type 小写
```

---

## 2. 功能在分支上开发

```
main                    始终可运行、可安装
feature/<短名>          新功能
fix/<短名>              缺陷修复
spike/<短名>            验证性实验，允许直接丢弃
```

规则：

- 一律从 `main` 切出，不要从别的功能分支再切
- 一个分支只做一件事；做两件事就开两个分支
- 分支名用英文短横线，不要中文、不要空格

---

## 3. 合并流程：先 rebase，再 merge

```bash
# 1. 在分支上完成开发并自测
git switch feature/xxx

# 2. 把 main 的最新改动变基到分支上，冲突在分支里解决
git switch main
git pull --ff-only             # 有远端时；纯本地仓库跳过这行
git switch feature/xxx
git rebase main

# 3. 跑完整回归（见第 4 节），必须全绿

# 4. 合入 main，保留功能边界
git switch main
git merge --no-ff feature/xxx -m "合并：<功能名>"

# 5. 清理分支
git branch -d feature/xxx
```

为什么先 rebase 再 merge：

- 冲突在**分支**里解决，`main` 上不会出现"解决冲突"这种噪音提交
- `--no-ff` 保留一个合并点，能一眼看出"这 8 个提交属于同一个功能"
- 出问题时 `git revert -m 1 <合并提交>` 可以整块回退，而不是逐个挑

---

## 4. 合并前的回归门槛

三项全过才允许合并：

```bash
node --test --test-force-exit test/*.test.mjs    # 必须全绿
node --check client/client.js                    # 面板语法
node bin/shell-check.mjs COM8                    # 有硬件时：字节透明验收
```

没有硬件时前两项必过，第三项在提交信息里写明"未验真机"。

---

## 5. 修 bug：优先改写，不要叠加

原则：**历史要读得懂，不要一堆 "修复上次改坏的地方"**。

| 情况 | 做法 |
|---|---|
| 提交还没合并进 `main` | `git commit --amend` 直接改内容或信息；或用 `git rebase -i <起点>` 选 `reword` / `edit` |
| 提交已经合并进 `main` | 不改写历史，新增一条 `fix:` 提交 |
| 已经推到远端 | **禁止** `push --force`；只做追加提交 |

示例：面板路径前缀写错（`/serial/serial/delete`），如果还在功能分支上，就直接 amend 掉那条提交，让合并进 `main` 的历史里从没出现过这个错误。

---

## 6. 标签

- 语义化版本：`v0.1.0` 起点，功能版本 `v0.2.0`，修复版本 `v0.2.1`
- 标签必须带中文说明：`git tag -a v0.2.0 -m "触发器：行级规则、命中记录、长轮询唤醒"`
- 打标签的时机：`main` 上回归全绿、且该版本可以安装使用

---

## 7. 提交前的自查

```bash
git status --short        # 不该出现 .tmp-data/、调试脚本、临时日志
git diff --stat           # 确认改动范围符合预期
git log --oneline -5      # 确认提交信息是中文、格式正确
```

禁止提交：`node_modules/`、`.tmp-data/`、`*.log`、任何含密钥或 token 的文件。
这些已在 `.gitignore` 中，若发现漏网，先补 `.gitignore` 再提交。

---

## 8. 回退

```bash
git log --oneline --decorate          # 找到目标
git checkout v0.1.0                   # 临时查看，不动当前分支
git reset --hard v0.1.0               # 彻底回到该版本
git checkout v0.1.0 -- src/store.mjs  # 只恢复单个文件
git revert <提交>                      # 已合并的提交用反向提交撤销
```

`reset --hard` 会丢工作区改动，执行前先 `git stash` 或确认没有未提交内容。
