> 当前版本 0.3.0 支持平台真实价格、首响应延迟及成功率排序与加权。默认真实价格优先。下文基础单价、缓存及特殊计费核查是历史证据，不再用于插件价格计算。

# 平台接口与计费核查

## HAR 证实

- `GET /api/v1/auth/me`：data 是含 id 的当前账号对象。
- `GET /api/v1/keys`：data.items + pages；响应可能含完整 key，不可持久化整个响应。
- `PUT /api/v1/keys/{id}/group`：仅发送 `group_id`，成功要求 HTTP 成功、code=0，并通过 keys 再读取确认。
- `GET /api/v2/public/providers?range=1h&include_media=false&timezone=Asia%2FShanghai`：价格、模型卡、可用状态、快照时间及 stale。
- 模型卡健康有效期在抓包中通常约 90 秒，明显短于轮询间隔，因此切换前再次验证时间；不能把历史健康状态跨轮沿用。

## 公开页面及部署前端核查（2026-10-30）

通过浏览器读取 https://aihub.top/providers，未登录，未调用真实改组操作。

- 模型卡显示“后端分组价格 / 每 1M Token · 1×”，输入、缓存输入、缓存写入、输出分别列价。
- 实际部署资源 `ProviderHall-9NYXZmDv.js` 的价格格式函数使用 `group_models[].price` 展示上述 1× 基础价。
- 同资源中的长上下文提示：“该分组已启用长上下文窗口，超过 272k Token 后按新的价格计费。”无法由此证实超过阈值后每个价格项具体如何调整，故高于边界的候选不比较。
- 部署资源 `groups-5ecM0F0g.js` 确认 `/groups/available` 和 `/groups/rates`。
- 部署主资源 `index-evOzNUrv.js` 确认 Bearer 登录令牌、账号会话及请求方式。插件不复制其刷新令牌流程。
- `peak-rate-qZGUWdry.js` 确认高峰起止及独立倍率存在；未核实服务端时区和完整结算逻辑，暂排除此类分组。

平台教程 https://aihub.top/tutorial 链接的底层公开项目为 https://github.com/Wei-Shaw/sub2api 。其前端 groups.ts、后端 api_key_handler.go 和 api_key_service.go 说明 available 是用户可绑定分组，rates 是 group_id 到用户专属倍率的映射。公开上游用于解释语义，不等于证明部署后端所有行为相同；插件对格式异常停止本轮。

## 插件实际读取范围

每轮只读当前账号、所有分页 key、providers、可绑定分组和用户专属倍率。只有用户明确启用某 key 自动切换、该 key 的规则成立时，才发出该 key 的 group PUT。写入前再次读取 keys；写后读取确认。

未验证：真实登录捕获和刷新后的持续运行、认证状态下的 available/rates 实际响应、真实 PUT 的失败路径与并发原子性。离线测试模拟这些响应，不把模拟结果说成线上验证。

## 0.1.1 价格列映射（2026-10-30 再核查）

部署前端 `ProviderHall-9NYXZmDv.js`：

- `fc` 在选择模型后，将 `summary_models[模型].effective_input_price_per_million` 投影为行价格；预测倍率及 ready 标记也从同一个模型摘要读取。
- `ee` 展示真实价格；`fe` 仅在 ready 为真时展示预测倍率。
- `ha` 获取真实价格，`effectivePrice` 排序通过 `_t(..., true)` 按真实价格升序排列。预测倍率不是另一个可替代的价格单位，不用于排序兜底。
- 插件直接使用指定模型的 `effective_input_price_per_million`，同时显示 ready 的 `effective_multiplier`。没有该模型价格时排除，不使用分组顶层聚合价格。
- 继续使用 1h 查询、快照与健康状态过期校验；价格缓存明确 stale 或 ready=false 时排除。取消独立单价计算和特殊计费标记排除。

该字段是平台定义的“真实价格”统计口径，不解释为用户请求的完整账单。账号可绑定分组及 key 倍率上限仍作为资格限制，专属倍率不再次乘入真实价格。


## 0.2.0 指标与策略映射

- 每个key可选择全局默认或独立策略；默认 `mode=price`，可选 `latency`、`success`、`weighted`。
- 延迟来自 `summary_models[模型].user_latency_ms`，成功率来自同摘要的 `success_rate`（0–1）；两者要求 sample_count>0，不用分组或其他模型兜底。
- 该映射与部署前端fc选择模型后的投影对应。真实价格继续使用前述字段，预测倍率仅辅助展示。
- 加权按本轮资格筛选且所需指标完整的候选做min-max归一化，权重0忽略，权重总和规范化。同指标同值给所有候选相同分，不偏向某一方。
- 单项与加权都按最终得分高者优先；同分不切。修改实际生效策略会清空观察计数，配置暂停与pending写入日志不丢失。


## 0.3.0 检测、表格与手动选择

HAR含model_detection对象：model、status、applicable、execution_complete及stages。默认检测筛选要求model与绑定模型完全一致、status=passed、applicable=true、execution_complete=true；若detection/text阶段显式带model，也要求一致。未提供检测有效期字段，因此不编造独立TTL；仍要求本轮快照和探测/模型健康有效。

手动改组复用已证实的group PUT，仅写group_id。UI确认后后台重新检查身份、keys当前分组、可绑定分组及指标；不要求目标排名第一，但必须属于当前资格集合。手动操作先暂停自动选择，失败/未知结果也保持暂停，pending日志可在暂停时读回核实。

表格原始倍率来自providers.rate_multiplier，账号倍率来自groups/rates覆盖值（无专属值则available倍率），预测倍率来自对应模型摘要；评分为插件当前候选相对分数，不是平台检测评分。
