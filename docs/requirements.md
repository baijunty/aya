# Aya — AI 模型请求转发管理与统计系统 需求文档

- 版本：v0.4
- 日期：2026-10-14
- 状态：技术选型已确认，待设计评审
- 变更记录：v0.2 确认技术栈为 Node.js/TypeScript；明确后端协议约束（后端须自带 OpenAI 兼容 API）；§9 开放问题部分关闭
- 变更记录：v0.3 新增 §3.6 模型主动加载/卸载接口与资源感知加载（内存不足时等待既有模型闲置并卸载后再加载，防 OOM）
- 变更记录：v0.4 目标主机为**统一内存**架构：资源探测与准入只判定系统内存，不再单独探测显存

---

## 1. 项目背景与目标

本地 / 私有环境中往往同时存在多个 AI 推理后端（如 vLLM、llama.cpp、whisper.cpp、各类 TTS 服务等），它们各自暴露不同端口、不同协议，且推理进程（尤其大模型）常驻会占用大量内存（统一内存主机上含 GPU 使用）。

本项目（暂定名 **Aya**）实现一个 **AI 模型请求转发网关**，对外提供统一的 **OpenAI 兼容 API**，对内完成：

1. **统一接入**：以 OpenAI 风格接口（聊天、图片生成、ASR、TTS 等）接收客户端请求；
2. **模型路由**：按请求中的 `model` 字段匹配到配置好的转发后端，转发请求并将后端应答原样回传（含流式）；
3. **后端进程管理**：按配置拉起 / 健康检查 / 停止后端进程，模型闲置达到阈值时主动卸载进程以释放资源；
4. **日志与统计**：记录每次请求的关键指标（响应时长、token 数、首 token 时间、缓存命中数等），并提供 Web 前端页面浏览统计信息。

### 1.1 成功标准（MVP）

- 主流 OpenAI SDK（python `openai`、curl）只需改 `base_url` 与 `model` 即可调用；
- 配置一个聊天模型后端后：冷启动（进程未运行）请求可自动拉起后端并成功应答；闲置超时后进程被自动停止；
- 统计页面可查看按模型 / 时间维度的请求量、延迟、TTFT、token 用量、缓存命中率与请求明细。

---

## 2. 术语定义

| 术语 | 含义 |
|---|---|
| 网关（Gateway） | 本项目进程，对外提供 OpenAI 兼容 API |
| 前端请求 | 客户端 → 网关 的请求 |
| 后端（Backend） | 实际执行推理的服务，分为「托管进程型」（由网关拉起/停止的本地进程）与「远程型」（已运行的 HTTP 服务）两类 |
| 模型（Model） | 对外暴露的模型名，映射到某个后端 |
| 工作状态 | 后端正在处理请求、正在加载模型、正在启动/预热等占用资源的状态 |
| 闲置（Idle） | 该模型无任何调用（无进行中请求、无排队请求），且后端不处于工作状态 |
| TTFT | Time To First Token，从网关开始转发到拿到**第一个生成出来的 token**（流式：首个带 `content`/`reasoning_content`/`tool_calls` 的 SSE 帧；非流式：响应体首字节）的时间。响应头、`delta:{role}` 起始帧与 `: ping` 注释心跳**都不算**，它们只代表「流已打开」，另记 `timeline.first_byte` |
| 缓存命中 | 后端 usage 中报告的 prompt cache / KV cache 命中 token 数（如 `usage.prompt_tokens_details.cached_tokens`） |

---

## 3. 功能需求

### 3.1 OpenAI 兼容 API 转发

网关对外提供以下接口（路径与语义对齐 OpenAI 官方 API）：

| 接口 | 方法/路径 | 说明 | 优先级 |
|---|---|---|---|
| 模型列表 | `GET /v1/models` | 返回已配置且启用的模型列表 | P0 |
| 聊天补全 | `POST /v1/chat/completions` | 支持非 JSON 与 **SSE 流式**（`stream: true`）两种应答 | P0 |
| 文本补全 | `POST /v1/completions` | 兼容旧式补全接口 | P1 |
| 向量嵌入 | `POST /v1/embeddings` | 文本向量化 | P1 |
| 图片生成 | `POST /v1/images/generations` | JSON 请求，透传应答 | P0 |
| 语音转文字 ASR | `POST /v1/audio/transcriptions` | **multipart/form-data** 文件上传转发 | P0 |
| 语音翻译 | `POST /v1/audio/translations` | 同上 | P2 |
| 文字转语音 TTS | `POST /v1/audio/speech` | 二进制音频流应答透传 | P0 |
| 健康检查 | `GET /healthz` | 网关自身健康，附带各后端状态 | P0 |

要求：

- **透传语义**：请求体、应答体、状态码、关键响应头尽量原样转发，不做语义改写；仅做路由与必要的字段校验/补齐（如缺省 `model` 校验）。
- **流式转发**：SSE 逐块透传，不缓冲整个响应；TTS 等二进制流式响应同样边收边发。
- **multipart 转发**：ASR 的文件上传需流式转发，避免大文件全量落内存（可设大小上限，默认如 100 MB，可配置）。
- **后端协议约束（已确认）**：转发按**路径透传**实现，前提是后端自身提供 OpenAI 兼容 HTTP API（如 llama.cpp server、本机 strata、gufo、vLLM 等，由配置命令拉起）。网关**不**为非 OpenAI 协议做格式适配。
- **统一错误格式**：网关自身产生的错误（模型不存在、后端启动失败、超时、排队溢出等）返回 OpenAI 风格错误 JSON：`{"error": {"message", "type", "code"}}`；后端返回的错误原样透传。
- **访问鉴权**：支持配置一组网关 API Key（`Authorization: Bearer`），未启用时放行（默认本地部署场景）。P1

### 3.2 模型与后端配置

支持在配置文件（YAML，见 §7）中声明后端与模型：

**后端（backend）配置项：**

| 字段 | 说明 |
|---|---|
| `name` | 后端唯一名 |
| `type` | `process`（托管进程）、`remote`（远程 HTTP 服务）、`cli`（一次性命令行工具，每请求 spawn 生成文件后退出，如 llama-tts）或 `passthrough`（纯转发远程 OpenAI 兼容 API：不托管进程、不探测健康，恒可服务，上游不可达快速失败） |
| `command` / `args` / `env` / `cwd` | process 型：启动命令、参数、环境变量、工作目录 |
| `base_url` | remote 型 / process 型 / passthrough 型：后端 HTTP 地址（process 型启动后用于健康检查与转发；passthrough 型为纯转发目标） |
| `api_key` | 上游 API Key（remote/passthrough）：注入 `Authorization: Bearer <key>`，独立于网关自身 `api_keys`；`auth` 显式头优先；两者都缺省则原样透传客户端 Authorization（上游 key 同自身设置） |
| `health_check` | 健康检查 URL、间隔、成功判定（状态码/JSON 字段） |
| `start_timeout` | 启动→就绪的超时（大模型加载可能数分钟） |
| `stop_grace_period` | 优雅停止等待时长，超时后强杀 |
| `idle_timeout` | 闲置多久后自动停止进程（0 = 不自动停止） |
| `auto_start` | 是否允许按需自动拉起（默认 true） |
| `max_concurrency` | 该后端并发处理请求上限 |
| `model_path` 等 | 供命令行模板插值使用的模型文件/权重路径等自定义参数 |

**模型（model）配置项：**

| 字段 | 说明 |
|---|---|
| `name` | 对外模型名（请求中 `model` 字段的匹配值） |
| `backend` | 关联的后端名 |
| `kind` | `chat` / `completion` / `embedding` / `image` / `asr` / `tts` / `decision`，用于接口类型校验与统计分类（`decision` = llama.cpp 原生决策模型，只接 `/v1/systemone`） |
| `context_length` | 上下文长度（用于 `/v1/models` 展示、超长请求预检、统计参考） |
| `max_tokens` | 默认最大输出 token（可选，透传前补齐） |
| `aliases` | 模型别名列表（如 `gpt-4o` → 本地 `qwen2.5-72b`），便于现有客户端无缝接入 |
| `enabled` | 启停开关 |

要求：

- 配置**热加载**：配置文件变更后自动生效（新增/修改模型与后端，不停机、不断流）；P1（MVP 可先支持 SIGHUP/手动 reload）
- 路由规则：`model` 名精确匹配 → 别名匹配；未命中返回 404 风格错误。同一模型多后端负载均衡/故障转移列为 P2。
- 管理 API（P1）：`/api/v1/backends`、`/api/v1/models` 提供只读状态查询与手动 start/stop/reload 操作，以及模型级 **load/unload 主动加载/卸载**接口（见 §3.6），供前端页面使用。

### 3.3 后端进程管理

**生命周期状态机：** `stopped → starting → ready → draining → stopped`，异常进入 `crashed`。

- **按需启动**：请求到达且后端为 `stopped` 时自动拉起（`auto_start: true`），请求进入等待队列直至就绪（受 `start_timeout` 与队列上限约束）；就绪前队列满或超时返回 503。
- **健康检查**：`starting` 阶段轮询健康检查接口判定就绪；`ready` 后周期性检查，连续失败标记 `crashed` 并按退避策略重启（重启次数/间隔可配置）。
- **崩溃处理**：进程意外退出时记录日志与事件；有排队/进行中请求时按策略重启，否则保持 stopped（等待下次按需拉起）。
- **闲置卸载（核心需求）**：
  - 判定条件：该后端在 `idle_timeout` 时长内 **没有任何请求**（无进行中、无排队、无新到达），且后端不处于工作状态（无模型加载/预热等）；
  - 达到阈值后执行**优雅停止**：进入 `draining`（不再接收新请求）→ 等待 in-flight 请求完成（上限 `stop_grace_period`）→ 终止进程（先 SIGTERM 后 SIGKILL）；
  - 「该模型闲置」以**后端**为粒度统计（一个后端服务多个模型时，任一模型活跃即视为活跃）；
  - 闲置计时以「最后一次请求结束时间」为起点，而非最后一次请求到达时间。
- **并发与排队**：每后端 `max_concurrency` 上限 + 等待队列（`queue_size`、`queue_timeout` 可配置），防止打爆后端。
- **进程组管理**：托管进程以独立进程组启动，停止时终止整个进程组，避免孤儿进程持续占用内存；网关自身退出时优雅关闭所有托管进程（可配置保留）。

### 3.4 日志与统计

**每次请求记录一条访问日志（request log），字段至少包含：**

| 分类 | 字段 |
|---|---|
| 标识 | `request_id`（网关生成，同时写入响应头 `X-Aya-Request-Id`）、时间戳 |
| 请求 | 客户端地址、API Key 标识（脱敏，仅 key id）、端点类型（chat/image/asr/tts/...）、模型名、是否流式、请求参数摘要（如 `max_tokens`、`temperature`、图片尺寸/数量、音频时长等，不记录正文内容） |
| 后端 | 后端名、后端耗时（转发发出→应答完成）、后端状态码 |
| 结果 | 网关状态码、成功/失败、错误信息、总延迟（收到请求→应答完成） |
| 性能 | **TTFT 首 token 时间**（流式：首个携带 token 的透传帧；非流式：响应体首字节。上游的响应头、role-only 起始帧与 SSE 心跳注释不计入，`timeline.first_byte` 单独记录） |
| Token | `prompt_tokens`、`completion_tokens`、`total_tokens`、**`cached_tokens`（缓存命中数）** |
| 流量 | 请求/响应字节数 |

**Token 统计口径：**

- 优先解析后端应答中的 `usage` 字段（含流式响应最后一个 chunk 携带的 usage，需开启 `stream_options.include_usage` 透传约定）；
- 后端回 `gzip/deflate/br/zstd` 压缩应答（远程 API 转发的常态）时，统计侧先解压再解析，转发侧仍按原字节透传——否则远程转发后端的 tokens/cached/TTFT 会集体缺失，明细里只剩延迟；
- 后端未返回 usage 时，按可配置的本地估算兜底（对 chat 用 tokenizer 估算，估算值打 `estimated` 标记）；ASR 记音频秒数，TTS 记输入字符数与音频字节数，图片记张数/尺寸。

**聚合统计（按 模型 × 时间粒度[分钟/小时/天] 预聚合或实时 SQL 聚合）：**

- 请求数、成功数、失败数、成功率；
- 延迟分布：avg / P50 / P90 / P95 / P99；
- TTFT 分布：avg / P95；
- token 用量：prompt / completion / total、每分钟 token 吞吐；
- 缓存：cached_tokens 总量、**缓存命中率 = cached_tokens / prompt_tokens**；
- 后端维度：启动次数、崩溃次数、运行时长、闲置停止次数。

**存储与输出：**

- 默认 **SQLite** 持久化（单文件、零依赖），保留天数可配置（默认如 90 天），过期自动清理；
- 运行日志（网关自身 + 托管进程 stdout/stderr）输出到文件与 stdout，支持按大小轮转；托管进程日志按后端归档，便于排障；
- 统计查询 API（供前端使用）：`/api/v1/stats/summary`、`/api/v1/stats/series`、`/api/v1/stats/requests`（分页明细）、`/api/v1/stats/requests/{id}`。

### 3.5 统计前端页面

内置 Web 管理台（网关同端口或独立端口提供静态资源），浏览上述统计信息：

1. **总览页**：今日/近 7 天/近 30 天切换；卡片展示请求总数、token 总量、平均延迟、P95 TTFT、错误率、缓存命中率；
2. **趋势图表**：请求量趋势、延迟趋势（avg/P95 双线）、token 用量堆叠图（prompt vs completion）、按模型占比（饼图/条形图）；
3. **请求明细**：表格分页展示 request log，支持按时间范围、模型、端点类型、状态（成功/失败）、是否流式过滤；点击行**下钻单请求详情**（全部字段、时间线：到达→排队→后端启动→后端首包→完成）；
4. **后端状态页**：各后端当前状态（stopped/starting/ready/crashed）、运行时长、最近活跃时间、**闲置倒计时**、累计启动/停止/崩溃次数；提供手动 启动/停止/重启 与模型 **加载/卸载** 按钮（P1）；展示**设备内存面板**（内存总量与可用、各后端声明需求与占用、进行中的加载任务与驱逐等待状态）；
5. 自动刷新（默认 10s，顶栏可切 5s/10s/30s/60s/关并手动刷新，后台标签页暂停、回前台立即补刷）与时间范围选择全局联动；刷新状态在页面上可见（档位、下次倒计时、上次刷新时刻、刷新中提示）。

要求：无需登录即可本地查看（与 API 鉴权策略一致，可配置）；移动端不做要求，桌面浏览器优先。

### 3.6 模型主动加载 / 卸载与资源保护

除按请求自动拉起（§3.3）外，提供**模型级主动加载 / 卸载接口**（管理 API，供前端看板与运维调用）：

- **加载** `POST /api/v1/models/{name}/load`：不等待业务请求，主动为该模型对应后端执行资源准入 → 启动进程 → 等待就绪（预热）；支持 `wait` 同步等待或立即返回任务状态；
- **卸载** `POST /api/v1/models/{name}/unload`：主动优雅停止该模型对应后端（drain 进行中请求后停止，`force=true` 跳过等待）；
- 后端为 remote 型时两接口为幂等空操作（仅健康确认）；一个后端服务多模型时，卸载响应需列出受影响模型。

**资源感知加载（防 OOM，核心需求；主机为统一内存架构，只判定系统内存）：**

1. **环境探测**：周期采集系统内存（总量 / 可用量，可用量取 MemAvailable 语义——含可回收缓存，与 OOM 规避口径一致）。统一内存主机上 CPU/GPU 共用同一内存池，**看系统内存即可，不单独探测显存**；
2. **资源声明**：后端配置声明加载所需内存 `required_memory: { mem_mb }`（建议按实测峰值填写）；
3. **准入检查**：**一切进程启动**（主动 load、请求触发的 auto_start、崩溃重启）前统一按**及时内存情况**检查 `可用内存 ≥ 所需 + 安全余量`，通过才允许启动——运行中后端按**实测驻留**参与扣减（声明值只在加载窗口内起预留作用，加载完毕不再重复扣减）；并发加载做**预留记账**，防止两个加载同时通过检查后合计 OOM；加载本身**严格串行**：同一时刻只允许一个后端处于加载窗口，后到者等前序加载完毕后重新估算内存再准入（并行加载的瞬时峰值不在声明值内，合计仍可能 OOM）；
4. **驱逐等待**：内存不足时，按策略选择其他后端为驱逐候选（`evictable` 默认可驱逐、`priority` 低者优先、闲置最久者优先），**等待候选闲置**（进行中请求自然完成，默认不打断）后将其卸载，重新检查内存，循环直至满足；
5. **失败语义**：等待超过 `evict_wait_timeout`（默认 10 分钟）仍无法腾出内存 → 加载失败返回 503 `resource_unavailable`，附阻塞详情（占用后端、需要/可用各多少），绝不「赌一把」启动导致后端 OOM 崩溃；
6. **可见性**：加载任务状态（`loading` / `pending_resources` + 正在等待哪些后端闲置卸载）可经 `GET /api/v1/resources` 与后端状态查询，前端展示。

---

## 4. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 网关自身增加延迟（非流式转发路径）P99 < 10 ms；支持 ≥ 256 并发长连接流式转发 |
| 可靠性 | 后端崩溃不影响网关与其他后端；统计写入失败不影响转发主链路（异步落库、可丢弃降级） |
| 资源 | 网关常驻内存 < 200 MB；托管进程停止后内存须实际释放（统一内存主机含 GPU 占用；依赖后端正确退出，网关负责杀进程组） |
| 安全 | 默认仅监听本机/内网；API Key 鉴权可启用；日志不落请求正文与音频内容（隐私）；HTTPS 可选（P2，或交由反代） |
| 部署 | 单一可执行文件 + 一个 YAML 配置 + 一个 SQLite 文件；提供 Docker 镜像与 docker-compose 示例 |
| 兼容 | OpenAI API v1 语义子集；兼容主流 SDK（openai-python / openai-node / curl） |
| 可观测 | 网关自身结构化日志；`/healthz`；关键事件（后端启停、崩溃、闲置卸载）记录事件表 |

---

## 5. 配置示例（示意）

```yaml
server:
  listen: "0.0.0.0:8000"
  api_keys: ["sk-aya-xxxx"]        # 为空则不鉴权
  static_ui: true

storage:
  type: sqlite
  path: ./data/aya.db
  retention_days: 90

resources:                          # 资源感知加载（防 OOM，见 §3.6；统一内存主机只看内存）
  probe_interval: 5s
  safety_margin_mb: 1024            # 安全余量
  evict_wait_timeout: 10m           # 等待驱逐候选闲置的最长时间
  allow_evict_busy: false           # 默认不打断使用中的后端

backends:
  - name: qwen-vllm
    type: process
    command: python -m vllm.entrypoints.openai.api_server
    args: ["--model", "{model_path}", "--max-model-len", "32768", "--port", "8100"]
    env: { CUDA_VISIBLE_DEVICES: "0" }
    base_url: "http://127.0.0.1:8100/v1"
    health_check: { path: /health, interval: 5s }
    start_timeout: 300s
    stop_grace_period: 60s
    idle_timeout: 15m              # 闲置 15 分钟自动停止
    max_concurrency: 8
    model_path: /models/Qwen2.5-7B-Instruct
    required_memory: { mem_mb: 16384 }         # 加载所需内存峰值（准入检查用）
    priority: 100            # 高优先级，难被驱逐
    evictable: true          # false = 常驻，永不被驱逐

  - name: whisper-local
    type: process
    command: ./whisper-server
    args: ["--model", "/models/whisper-large-v3", "--port", "8101"]
    base_url: "http://127.0.0.1:8101/v1"
    idle_timeout: 5m

  - name: tts-remote
    type: remote
    base_url: "http://192.168.1.20:5000/v1"

models:
  - name: qwen2.5-7b-instruct
    aliases: ["gpt-4o-mini"]
    backend: qwen-vllm
    kind: chat
    context_length: 32768
  - name: whisper-large-v3
    backend: whisper-local
    kind: asr
  - name: cosyvoice-tts
    backend: tts-remote
    kind: tts
```

---

## 6. 数据模型草案（SQLite）

```
request_logs(
  id, request_id, ts_start, ts_end,
  client_addr, key_id, endpoint, model, backend,
  is_stream, status_code, ok, error,
  latency_ms, backend_ms, ttft_ms,
  prompt_tokens, completion_tokens, total_tokens, cached_tokens,
  tokens_estimated, req_bytes, resp_bytes, req_summary_json
)
index: (ts_start), (model, ts_start), (endpoint, ts_start)

backend_events(id, ts, backend, event, detail)   -- start/stop/crash/idle_stop

stats_hourly(bucket, model, endpoint, req_count, ok_count, fail_count,
             latency_sum, latency_p50/p95(近似), ttft_sum/p95,
             prompt_tokens, completion_tokens, cached_tokens)  -- 可选预聚合
```

---

## 7. 技术选型（已确认：Node.js / TypeScript）

| 项 | 决定 | 说明 |
|---|---|---|
| 运行时/语言 | **Node.js ≥ 22 LTS + TypeScript 5（strict, ESM）** | 前后端同语言，流式转发可胜任 |
| HTTP 框架 | Fastify 5 | 可拿到原始请求流做纯透传，`reply.raw` 完全控制 SSE/二进制 |
| 上游客户端 | undici（Node 内置） | 连接池 + stream pipeline |
| 前端 | React + Vite + ECharts，构建产物由网关静态托管 | 图表生态成熟 |
| 存储 | SQLite（better-sqlite3，WAL） | 零依赖单文件 |
| 进程管理 | `child_process.spawn`（detached 进程组），SIGTERM→超时 SIGKILL 整组 | 可靠回收内存 |
| 配置 | YAML + zod 校验 + 文件监听热加载 | 简单直观 |

详细选型理由与模块设计见 [design.md](design.md)，接口约定见 [api-design.md](api-design.md)。

---

## 8. 里程碑规划

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 核心转发 | 配置加载、chat/images/audio 接口转发（含流式/multipart）、`/v1/models`、统一错误 | OpenAI SDK 直连可用 |
| M2 进程管理与资源保护 | 托管进程启停、健康检查、按需启动、闲置卸载、崩溃重启；内存探测 + 加载准入 + 驱逐等待；模型 load/unload API | 冷启动请求成功；闲置后进程停止；内存释放；内存不足时先等闲置模型卸载再加载，不 OOM |
| M3 日志统计 | request log、SQLite 落库、聚合统计 API | 明细与聚合数据正确可查 |
| M4 前端看板 | 总览/趋势/明细/后端状态四页 | 浏览器完整浏览统计 |
| M5 打磨 | API Key 鉴权、配置热加载、手动启停按钮、Docker 化、文档 | 部署文档 + compose 一键起 |

---

## 9. 开放问题

**已关闭：**

1. ~~后端范围~~ → **已确认**：后端由配置命令拉起（llama.cpp、本机 strata、gufo 等）或配置为远程服务，唯一约束是后端自身提供 OpenAI 兼容 API，网关按路径透传、不做协议适配。
5. ~~语言偏好~~ → **已确认**：Node.js / TypeScript。

**仍待确认（不阻塞 M1 开发，默认按括号内假设走）：**

2. **鉴权与多租户**：是否需要多用户、配额/限流、计费？（默认：纯个人/内网工具，仅单一 API Key 集合，无限流计费）
3. **缓存统计口径**：以后端 usage 的 `cached_tokens` 为准；后端不返回 usage 时只记估算 token 数、缓存命中率记为 0 并打 `estimated` 标记。（默认假设）
4. **远程后端到公网**：`remote` 型后端是否允许指向 OpenAI 官方等公网上游？（默认：允许，配置 `base_url` 即可，鉴权头由配置注入）
6. **管理台鉴权**：统计页面是否需与 API 相同 Key 保护？（默认：与 API 相同——启用 `api_keys` 时管理台与统计 API 同样要求鉴权）
