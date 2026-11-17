# dsh-plan-steps

中文 | [English](README.en.md)

给 DeepSeek Harness 用的「计划步骤」：`plan_write` 记录两级计划，`complete_step`
一项一项签核并由宿主推进，守卫拒绝未签核的完成，列表还开着时轮末会被拉回，面板上
实时显示当前项与「已完成 N / M」。

设计参考了 [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的
`todo_write` / `complete_step` / `AdvanceSerialTodo` 语义（两级阶段与子步骤、稳定
`step_id`、阶段最后签核）。这个插件是按 DSH 的事件与槽位模型重写的实现，不是它的
移植。

## 带来什么

| 部件 | 作用 |
| --- | --- |
| `plan_write` | 记录两级计划：`level` 0 是阶段，`level` 1 是它的子步骤，每项可带稳定 `step_id`，全表只有一个当前项。重写时执行连续性校验：已有的 id 不能丢、当前项不能被删或降级、已完成项保持原位；上一份计划全部完成后可以直接写新计划。 |
| `complete_step` | 签掉当前 `in_progress` 那一项，宿主推进列表并写入 `todo/write` 快照（面板随之更新），再把下一步告诉你。阶段必须等子步骤全部完成后才能签。 |
| 守卫 | 列表里还开着的项被 `plan_write` / `todo_write` 直接标成 `completed` 时拒绝。 |
| 收尾拉回 | 轮末列表还有未完成项时，用 `agent.steer()` 把这一轮拉回来——每轮最多一次。 |
| `wait_for_user` | 声明「在等用户」，这一轮就不会被拉回。 |
| `abandon_plan` | 放弃当前计划：清空列表、面板消失，`reason` 必填并留在会话记录里。这是唯一绕过重写连续性校验的写入。 |
| 上下文召回 | 可见窗口里没有当前列表时，把「Host task state」块注入请求。 |
| 面板 | 接管输入框上方的任务面板，显示当前项名字 + 「已完成 N / M」+ 分段进度条，展开是两级缩进列表。 |
| 工具行 | 每次 `complete_step` 也会带同样的位置信息。 |

列表本身是会话日志里最后一条 `todo/write` 事件，所以折叠、分支、重启之后推导出的
是同一份列表；插件内存里不缓存任何状态。

## 为什么要把「写计划」和「签核」分开

内置的 `todo_write` 是模型自己的一句话：它既记录计划，又声明完工。这两件事混在一个
动作里，就分不出「我做完了」和「我想把它从列表划掉」；而且折叠之后，模型手里连那张
表都没有了。

拆开之后，边界变成结构性的：

- `plan_write` 管计划：有哪些步骤、什么顺序
- `complete_step` 管执行：一次一项、只签当前项、签完才推进
- 宿主管列表：于是「签过」和「还开着」是它能在守卫、轮末、请求三处校验的事实

## 推进规则

顺序推进、深度优先：阶段内的子步骤按列表顺序做；子步骤跑的时候阶段保持 `pending`，
全部完成之后阶段才成为当前项（阶段最后签）；签掉阶段才轮到下一个阶段的第一个子步骤。

```
1 调研与设计          pending
   1.1 读现有实现      in_progress   ← 当前
   1.2 记录要点        pending
2 实现                pending
   2.1 改代码          pending
```

签 1.1 → 1.2 成为当前；签 1.2 → 阶段 1 成为当前等待签收；签 1 → 2.1 成为当前。
这三条在数据上强制：阶段带着未完成子步骤时既不能是 `in_progress`，也不能被签核。

## 工具

**`plan_write`**

| 参数 | 说明 |
| --- | --- |
| `todos[].content` | 任务名，必填且不能重复 |
| `todos[].status` | `pending` / `in_progress` / `completed` |
| `todos[].level` | `0` 阶段，`1` 子步骤 |
| `todos[].step_id` | 稳定身份，重写时原样抄回 |
| `todos[].activeForm` | 进行时描述，可选 |

**`complete_step`**

| 参数 | 说明 |
| --- | --- |
| `step_id` | 首选，稳定身份 |
| `step` | 项目名，没有 id 时用 |
| `index` | 1-based 序号，前两者都不可用时用 |
| `result` | 必填，说明这一步之后什么成立了 |

**`wait_for_user`**

| 参数 | 说明 |
| --- | --- |
| `need` | 一句话说清在等什么；占位词会被拒绝 |

## 安装

本地目录安装，无构建步骤、无运行时依赖：

```sh
# 界面：插件 > 添加插件 > 选这个目录
# 或用管理工具：
#   install_bundle(target: "D:/dsh-plugins/dsh-plan-steps")
```

从 GitHub 安装（真实文件落进 profile，客户端半也能被服务）：

```sh
dsh plugin --profile desktop add github:GrounzerLiu/dsh-plan-steps
# 再把 dsh-plan-steps 加进 profile 的 dsh.profile.bundles
```

bundle 会插入一行 `include:plan-steps`，并让 `plan_write`、`complete_step`、`wait_for_user`、
`abandon_plan` 四个工具进入模型工具集。

**客户端半需要 tarball / git 安装。** `link:` 安装时 Web 端取不到
`/plugins/<id>/client.js`（路径落在 profile 之外，浏览器 404），面板不会变样；
宿主侧的工具不受影响。装完后刷新一次页面，客户端模块才会进入启动图。

## 配置

五个开关在**插件自己的页面**上：插件管理器里找到 `plan-steps` 那一行，点右侧的「配置」进入，页面上直接勾选/取消。

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 拒绝未签核的完成 | 开 | 关掉后 `plan_write` / `todo_write` 可以自己把项标成完成 |
| 列表开着时拉回一轮 | 开 | 关掉后轮末不再 steer，列表开着也能结束 |
| 每轮重建面板快照 | 开 | 关掉后 `turn/start` 之后面板要等模型自己写一次才恢复 |
| 计划久未更新时提醒 | 开 | 连续若干步没碰计划且还有未完成项时，往请求里塞一句「记得推进」的提示 |
| 提醒阈值（步） | 20 | 上面那条的步数，同时也是两次提醒之间的最小间隔 |

同样的字段也可以写在 profile 的 `cordis.patch.yml` 里该行的 `config` 下，作为部署默认；插件页上的值优先。关掉开关不影响工具注册。

## 卸载

插件管理里 `remove_bundle`，或关掉 `plan-steps` 那一行。插件不往目录外写东西，删了
不需要清理；之前写下的任务列表仍留在会话日志里，内置面板照样能读。

## 测试

```sh
node --test test/
```

19 个用例，覆盖两级推进的五种走位、重写的三条连续性规则、序列校验、调用重放等。

## 排错

**每轮开始面板会空一下。** 内置任务投影在 `turn/start` 重置。插件在下一个宏任务把
未完成的列表写回去，第一步还会再兜底一次；早写失败时每个会话记一条警告
（`plan-steps: could not restore the task panel at turn start`），所以宿主行为变了
能在日志里看出来，而不是悄悄空白。

**`complete_step` 说没有任务列表。** 本会话还没有成功的 `plan_write`，或宿主既没有
投影也没有会话日志可读。先建列表。

**完成被拒绝。** 守卫或连续性校验拦下了：可能在 `plan_write` 里直接标了
`completed`，也可能重写时丢掉了 id、删掉或降级了当前项、移动了已完成项。先
`complete_step`，再改列表。

**一轮总被拉回。** 列表还开着时每轮最多拉一次，这是设计。要正常结束就调
`wait_for_user` 说明在等什么；要彻底关掉就设 `PLAN_STEPS_HOLD=0`。

**`step "..." matches no task-list item`。** 列表是从日志重建的，引用必须命中当前
快照里的项；报错会列出每一项的状态与位置。

## 许可

MIT，见 [LICENSE](LICENSE)。

面板里的图标路径数据来自 [Material Symbols](https://fonts.google.com/icons)
（Google，Apache-2.0）：`client.js` 里的 checklist / check-circle / chevron。

## 设计取舍

没有硬性收尾闸门、面板仍归内置那份投影、层级靠内容里的零宽标记穿过投影——这些是
刻意的取舍，理由写在 [docs/DETAIL.md](docs/DETAIL.md)。
