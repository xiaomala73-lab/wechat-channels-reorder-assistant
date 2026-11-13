# 千川与视频号油猴脚本

所有脚本都在仓库根目录。用装有 Tampermonkey 的浏览器打开下方链接，即可安装对应版本。

## 安装与订阅

| 千川助手 | Windows | 安卓 |
| --- | --- | --- |
| 直播定时调速 | [v1.2.4](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-windows.user.js) | [v1.2.7](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-live-speed-android.user.js) |
| 调控 | [v0.1.11](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-windows.user.js) | [v0.1.15](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-task-governor-android.user.js) |
| 素材追投 | [v0.4.36](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-windows.user.js) | [v0.4.38](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-chase-android.user.js) |
| 零消耗素材清理 | [v1.1.5](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-windows.user.js) | [v1.1.7](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/qianchuan-zero-cost-cleaner-android.user.js) |

| 视频号助手 | 安装与订阅 |
| --- | --- |
| 主页带货发布 | [v1.1.2](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/channels-home-video-publisher.user.js) |
| 标准订单逐单加热（视频号追投） | [v0.2.6](https://raw.githubusercontent.com/xiaomala73-lab/wechat-channels-reorder-assistant/main/%E8%A7%86%E9%A2%91%E5%8F%B7%E6%A0%87%E5%87%86%E8%AE%A2%E5%8D%95%E9%80%90%E5%8D%95%E5%8A%A0%E7%83%AD%E5%8A%A9%E6%89%8B.user.js) |

安装或覆盖更新后，保持 Tampermonkey 的「检查更新」开启。后续版本会使用表中的同一个地址。浏览器本地保存的清单和参数需要在各设备分别设置。

主页带货发布助手默认收起，点击页面右侧的「发布助手」即可展开。上传和商品动态选择器需要按页面校准，首次运行可使用默认的试跑模式。逐单加热助手由用户手动完成每一单的支付。

## 本地验证

在仓库根目录运行 `node --test` 可执行视频号逐单加热助手的回归测试。测试覆盖来源订单定位、名称与预算、优惠券和支付结果核对。

```sh
node --check "视频号标准订单逐单加热助手.user.js"
node --test
```

## 视频号逐单加热助手版本记录

- `v0.2.6` 修复订单创建日期选择器未打开导致的扫描超时。按投放进度判断已消耗是否达到预算，ROI 读取「直接成交 ROI」。
- `v0.2.5` 填写最低直接成交 ROI 后，按北京时间筛选今天创建的订单。每个名称只选列表中第一笔消耗完成且达到门槛的订单，没有达标的名称跳过。留空时按名称和页面当前筛选条件扫描。
- `v0.2.4` 添加 Tampermonkey 在线安装与更新地址。
- `v0.2.3` 保存每笔来源订单所在页，优先在记录页及后续页查找，必要时回查前页。使用来源订单 ID 精确核对。

更新时保留脚本文件名、`@name`、`@namespace` 和更新网址，增加 `@version`。通过检查后将新版本提交到 `main`，并更新本页对应版本。
