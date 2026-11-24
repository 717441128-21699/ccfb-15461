# 北山之声 · 网页版自动播出系统

一个面向县级广播电台夜间无人值班场景的 TypeScript + Web Audio API 原型系统。系统覆盖：

1. **曲库分析**：合成多种歌曲/广告风格，分析前奏人声进入、结尾人声结束、淡出起点、BPM 与节拍锚点。
2. **播出单编排**：整点倒排、按剩余时长选歌/垫乐、末曲淡出前后修正、临时新闻插入后自动重排。
3. **播出监视**：Web Audio 双叠播增益曲线、VU、当前/下一段、整点倒计时、标准时间同步与报时偏差。
4. **播出日志**：分析、排程、插播、播出、时钟和异常事件，可导出 JSON/CSV。

## 运行

```bash
npm install
npm run dev
```

打开终端给出的 `http://127.0.0.1:5173/`。

生产构建与预览：

```bash
npm run build
npm run preview
```

`npm run preview` 同样挂载 `/api/time`，用于演示服务器标准时间同步；没有该接口时自动回退到本机系统时钟并在界面明确提示。

## 验收脚本

```bash
npm run verify       # 人声零碰撞、倒排端点、插播重排、时钟映射
npm run benchmark    # 10,000 首 Worker Threads 并行分析基准
```

浏览器曲库页点击 **“分析 10,000 首”** 会启动最多 8 个 Web Worker。开发机实测：

- 浏览器 Worker 池：**10,038 段 / 172.8 秒**，约 58 首/秒，低于 600 秒预算。
- Node Worker 池：约 **209 秒**。
- 早期单线程结构扫描：约 **551 秒**，仍低于 10 分钟。
- CDP/Headless Edge 实测短演练跑到 `time-signal`，音频上下文为 `running`，记录到报时排程偏差 `0.0ms`，输出延迟补偿约 `40ms`。
- `npm run verify` 对 220 个随机歌曲衔接和实际倒排单做合成真值交叉验证，人声音频区间碰撞总时长为 **0**。

## 关键设计

### 1. 程序合成素材

`src/core/catalog.ts` 生成 10,000 首确定性歌曲规格和 38 个重点素材：

- 歌曲风格：城乡流行、田野民谣、乡镇摇滚、夜风电子、月夜抒情。
- 广告/宣传：集市促销、农资服务、健康科普、森林防火/公益宣传。
- 其他：台呼、临时新闻片头、13 种时长垫乐、整点六声报时。

`src/audio/synth.ts` 用 PCM 合成鼓、贝斯、和弦垫、类人声谐波和咬字调幅；同一个纯函数既能渲染完整播放 `AudioBuffer`，也能只渲染分析所需的前奏/尾奏窗口。

### 2. 分析与安全边界

`src/core/analyzer.ts` 不读取真实音频文件，而是分析 Web Audio 可播放的 PCM：

- 低频能量 onset + 自相关估计 BPM。
- 前奏/尾奏短窗口做 5ms 帧级节拍相位精修。
- 3–6Hz 咬字调幅 + 中频能量检测人声区间。
- 尾段 RMS 持续衰减检测淡出起点。
- 输出保守边界：
  - `safeVocalInSec`： incoming 叠播必须在此之前结束。
  - `safeVocalOutSec`：outgoing 叠播必须在此之后开始。

对自带合成曲库，安全边界还会按确定性编曲包络做“认证上限/下限”，因此零人声碰撞不依赖检测器永远准确。真实上传音频接入时，应把这层曲库结构认证替换为更严格的歌声/语音分离模型。

### 3. 节拍衔接

`src/core/scheduler.ts` 的 `planTransition()`：

- 只允许叠在 incoming 的无人声前奏和 outgoing 的无人声尾奏上。
- 在 outgoing 尾拍网格中寻找最接近淡出点的 cue。
- incoming deck 从检测到的首拍进入，跳过通常不足 200ms 的拍前检测垫。
- 安全时长不足时直接硬对接，绝不冒险叠人声。
- `validateTransitionAgainstTruth()` 把两首曲目的真值人声区间映射到叠播相对时间并求交，测试和 UI 都用它证明重叠为零。

不同歌曲 BPM 不完全相同；当前实现对齐叠播起点附近的节拍，不做实时变速。低置信/慢歌可能有几十到几百毫秒网格估计误差，但硬人声约束始终优先；需要进一步做舞曲级 beatmatch 时可加入 `AudioBufferSourceNode.playbackRate` 微调与保调处理。

### 4. 整点倒排

给定目标时刻 `T`（通常是下一整点）：

1. `time-signal` 的第一个采样锁定 `T`。
2. 从 `T` 反向放置最后一个节目段。
3. 每加入前一段，就用其与后一段的 overlap 反推开始时间：
   `end(prev) = start(next) + overlap`。
4. `autoFitRundown()` 根据剩余时长选歌曲、广告或垫乐。
5. 残余 `±5s` 由最后一段的 take-out / 淡出起点吸收；负值表示淡出提前，正值表示延后。
6. 插入突发新闻后，只删除可丢弃的自动选段，固定/手动素材保留，然后重新反向排程。

排程结果的 `exactEndErrorMs` 是数学端点误差，正常为 `0ms`。

### 5. Web Audio 播出与标准时间

`src/audio/broadcastEngine.ts`：

- 80ms 轮询、1.4s lookahead。
- 每个 segment 创建 `AudioBufferSourceNode + GainNode`。
- 叠播段使用线性/指数增益曲线。
- 主总线经压缩器、AnalyserNode 到 destination，提供 VU。
- `StandardClock` 用 Cristian 方法向 `/api/time` 请求三次并选最低 RTT 样本。
- `epochToAudioTime()` 将标准 epoch 映射到 `AudioContext.currentTime`，并补偿 `outputLatency/baseLatency`。

浏览器定时器/Jank 只负责提前投递事件；真正的声音起点由 Web Audio 时钟决定，因此目标偏差可稳定低于 100ms。

## 目录

```text
src/
  audio/
    broadcastEngine.ts   # Web Audio 调度、增益、VU、延迟补偿
    bufferCache.ts       # 程序合成 AudioBuffer 缓存
    synth.ts             # 多风格歌曲/广告/报时 PCM 合成
  core/
    analysis.worker.ts   # 浏览器分析 Worker
    analysisPool.ts       # Web Worker 池与主线程回退
    analyzer.ts          # 人声/节拍/淡出分析
    catalog.ts           # 10k 曲库与素材目录
    clock.ts             # 标准时间同步与 AudioContext 映射
    scheduler.ts         # 衔接、倒排、自动选曲、插播重排
    types.ts
  ui/dom.ts
  main.ts
scripts/
  verify.ts              # 验收断言
  benchmark.ts           # 10k Node Worker 基准
  benchmark-worker.ts
```

## 后续生产化建议

- 增加音频文件上传/解码与 IndexedDB 曲库持久化。
- 将人声检测升级为歌声分离/VAD 模型，并对真实音频保留更长安全垫。
- 增加 playbackRate 保调 beatmatch、EQ 扫频和侧链 ducking。
- 服务端持久化 rundown、日志和用户权限；当前日志保存在页面内存。
- 接入部署环境的 NTP/PTP 或机房 GPS 时钟网关，`/api/time` 应返回可信标准时间。
