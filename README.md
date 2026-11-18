# 千川与视频号油猴脚本

所有脚本都在仓库根目录。用装有 Tampermonkey 的浏览器打开下方链接，即可安装对应版本。

## 安装与订阅

| 千川助手 | Windows | 安卓 |
| --- | --- | --- |
| 直播定时调速 | [v1.2.10](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-windows.user.js) | [v1.2.14](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-android.user.js) |
| 调控 | [v0.1.16](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-windows.user.js) | [v0.1.21](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-android.user.js) |
| 素材追投 | [v0.4.40](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-windows.user.js) | [v0.4.42](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-android.user.js) |
| 零消耗素材清理 | [v1.1.8](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-windows.user.js) | [v1.1.10](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-android.user.js) |

| 视频号助手 | 安装与订阅 |
| --- | --- |
| 主页带货发布 | [v1.1.2](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/channels-home-video-publisher.user.js) |
| 标准订单逐单加热（视频号追投） | [v0.2.8](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/%E8%A7%86%E9%A2%91%E5%8F%B7%E6%A0%87%E5%87%86%E8%AE%A2%E5%8D%95%E9%80%90%E5%8D%95%E5%8A%A0%E7%83%AD%E5%8A%A9%E6%89%8B.user.js) |

安装或覆盖更新后，保持 Tampermonkey 的「检查更新」开启。后续版本会使用表中的同一个地址。浏览器本地保存的清单和参数需要在各设备分别设置。

素材追投助手默认将直播计划的性别定向设为「女」。直播定时调速助手默认单次预算 200 元、调控时长 2 小时、续投间隔 2 小时、计划当日上限 1600 元；旧配置中的非空自定义值继续保留。

安卓四个千川助手的面板和侧边入口会抵消网页双指缩放；横屏和竖屏各自保留拖动位置。窄屏或键盘弹出时，面板会收窄或缩短以留在可见区域。

素材追投在 Windows 和安卓的计划锁定后，默认每轮最多 20 组。计划 `1832800495529143` 默认每组 1 条，计划 `1840851764337800` 默认每组 2 条，适用于 ROI 和日期模式。其他计划沿用原每组条数，预填值仍可手改。

素材追投、调控、零消耗素材清理异常暂停后，回原计划并点「继续本轮」。进度保留在原浏览器标签页，刷新后可重新锁定原计划再续跑，不在设备之间同步。追投沿用已提交组数及素材 ID；调控只处理原已确认清单中尚未完成且依然符合条件的任务；清理沿用原页、累计删除额度和 AIGC 逐条排查进度。提交结果不明时，先读平台结果：追投用「只重新核查未核清任务」，调控或清理须回原列表核实预算、删除或标签结果。没有可核实的结果时会暂停。

主页带货发布助手默认收起，点击页面右侧的「发布助手」即可展开。上传和商品动态选择器需要按页面校准，首次运行可使用默认的试跑模式。逐单加热助手由用户手动完成每一单的支付。

## 调控助手：按计划 ID 预填默认值

Windows `v0.1.13` / 安卓 `v0.1.18`：锁定推商品计划后，默认选择「商品低 ROI 批量删除（逐条执行）」并预填下表 ROI。锁定直播计划时保留适用的直播操作；选择「直播低 ROI 批量删除」后预填直播默认 ROI，不改变直播追加预算的 ROI、差值和追加金额。

Windows `v0.1.15` / 安卓 `v0.1.20` 起，直播任务因「任务预算不足」暂停时，支付 ROI 达标且消耗达到当前预算才会入选追加清单；以下两个直播计划锁定后选择「直播高 ROI 追加预算」会自动填入对应的 ROI、预算差值和追加金额。

| 计划类型 | 计划 ID | 默认 ROI |
| --- | --- | --- |
| 推商品 | `1852467269069907` | 1.5 |
| 推商品 | `1867759385277658` | 1.5 |
| 推商品 | `1874562792641564` | 1.5 |
| 推商品 | `1871602977211450` | 1.5 |
| 推商品 | `1867205504686219` | 1.5 |
| 推商品 | `1861549677969523` | 2.2 |
| 推商品 | `1840851764337800` | 2 |
| 推商品 | `1832800495529143` | 2.3 |
| 推商品 | `1832698672535955` | 2.3 |
| 推商品 | `1832698376359401` | 2.3 |
| 直播低 ROI 删除 | `1832698106712151` | 2.3 |
| 直播低 ROI 删除 | `1837421927864619` | 1.5 |

| 直播高 ROI 追加预算计划 ID | 调控支付 ROI 不低于 | 预算 − 消耗低于（元） | 每条追加预算（元） |
| --- | ---: | ---: | ---: |
| `1832698106712151` | 2.3 | 99 | 300 |
| `1837421927864619` | 1.5 | 99 | 300 |

名单外 ID 的删除 ROI 和直播追加预算参数留空，必须手动填写，不继承其他计划的值。默认值可手动改写；普通重绘、检查本页和刷新同一已绑定计划不会覆盖手动值。重新点击「锁定当前计划」或重新选择对应直播操作会恢复该计划默认值。旧版恢复锁定或账号/类型/计划绑定变化时重新应用默认值，防止跨计划误用参数。预填不会自动检查或执行，商品删除仍逐条核对、逐条执行。

## 调控助手：共用 ROI 阈值

Windows `v0.1.12` / 安卓 `v0.1.17` 的商品调控只需输入一个「调控 ROI 阈值」：自动按当前任务表显示的「调控综合营销ROI」或「调控支付ROI」判定；两列都显示时共用此阈值，保留原来任一已显示列低于阈值或为「—」即入选的规则，不相加、不取平均。未显示列不参与判断，综合成本和调控消耗必须均大于零；仍需先检查清单，再确认执行。

旧版两项阈值相同或只保存一项时自动继承；两项不同则留空，必须重新填写，避免擅自改变删除门槛。直播和商品的低 ROI 删除都保留调控消耗为 0 或无法确认消耗的任务；商品删除还要求综合成本大于 0。直播删除仍按调控支付 ROI 阈值筛选调控中任务，追加预算规则不变。

## 本地验证

在仓库根目录运行 `node --test` 可执行调控助手与视频号逐单加热助手的离线回归测试。调控测试覆盖逐个计划默认值、默认操作、名单外留空、计划切换/重锁/刷新、统一输入、ROI 字段判定、成本消耗保护、输入校验和旧配置迁移。

```sh
node --check qianchuan-task-governor-windows.user.js
node --check qianchuan-task-governor-android.user.js
node --check "视频号标准订单逐单加热助手.user.js"
node --test
```

## 视频号逐单加热助手版本记录

- `v0.2.8` 填写最低 ROI 时，同名订单只检查列表顺序中的第一笔；只有该笔消耗完成且 ROI 达标才进入候选。第一笔未达标时整组跳过，不再用后续同名、不同金额的订单替补。
- `v0.2.7` 修复当天筛选结果只有一页、平台不渲染页码组件时被误判为“标准订单表加载超时”的问题；订单表识别兼容页面类名变化，超时记录会附上页码、订单总数、可见行数和加载状态。
- `v0.2.6` 修复订单创建日期选择器未打开导致的扫描超时。按投放进度判断已消耗是否达到预算，ROI 读取「直接成交 ROI」。
- `v0.2.5` 填写最低直接成交 ROI 后，按北京时间筛选今天创建的订单。每个名称只选列表中第一笔消耗完成且达到门槛的订单，没有达标的名称跳过。留空时按名称和页面当前筛选条件扫描。
- `v0.2.4` 添加 Tampermonkey 在线安装与更新地址。
- `v0.2.3` 保存每笔来源订单所在页，优先在记录页及后续页查找，必要时回查前页。使用来源订单 ID 精确核对。

更新时保留脚本文件名、`@name`、`@namespace` 和更新网址，增加 `@version`。通过检查后将新版本提交到 `main`，并更新本页对应版本。
