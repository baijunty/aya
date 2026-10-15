# Aya API 设计文档

- 版本：v0.3
- 日期：2026-10-14
- 关联：[需求文档](requirements.md) · [详细设计](design.md)
- 变更：v0.2 新增 B1a 模型主动加载/卸载接口与资源查询接口（资源准入 + 驱逐等待，防 OOM）
- 变更：v0.3 适配统一内存主机：资源维度仅系统内存（`mem_mb`），响应中无显存字段

分两类：**A. OpenAI 兼容转发接口**（`/v1/*`，对客户端）与 **B. 管理/统计接口**（`/api/v1/*`，对前端看板与运维）。

---

## 0. 通用约定

- **Base URL**：`http://<host>:<port>`（默认 `127.0.0.1:8000`）。客户端把 OpenAI SDK 的 `base_url` 指到这里即可。
- **鉴权**：`server.api_keys` 为空且未配置 `server.ui_auth` 则全部放行。`api_keys` 非空时 `/v1/*` 与 `/api/v1/*` 需 `Authorization: Bearer <key>`；配置 `ui_auth`（看板登录）后，同一批端点接受「Bearer API Key **或** 有效登录会话 Cookie（`aya_session`，HttpOnly）」任一——程序化调用带 Key，看板走登录。`/healthz`、`/api/v1/auth/login|logout` 与静态前端资源（`/`、`/assets/*`）不鉴权。
- **请求 ID**：网关为每个 `/v1` 请求生成 `request_id`，响应头回 `X-Aya-Request-Id`，同时落库，供明细下钻。
- **透传**：`/v1/*` 的请求体、应答体、状态码、关键响应头原样透传；仅注入/覆盖必要头（见各接口）。
- **错误体**（网关自身产生）：
  ```json
  { "error": { "message": "model 'foo' not found", "type": "invalid_request_error", "code": "model_not_found", "param": "model" } }
  ```
  上游后端返回的错误**原样透传**，不改写。

---

## A. OpenAI 兼容转发接口（`/v1/*`）

所有接口按请求 `model` 路由到后端；`model` 支持别名解析。请求体流式透传，响应按下表回传。

### A1. `GET /v1/models` — 模型列表

返回已启用模型（OpenAI 格式）。

```json
{
  "object": "list",
  "data": [
    { "id": "qwen2.5-7b-instruct", "object": "model", "created": 1700000000, "owned_by": "aya",
      "context_length": 32768 }
  ]
}
```
> `context_length` 为扩展字段（若客户端 schema 严格可忽略）。别名不单独列出（`id` 为规范名）。

### A2. `POST /v1/chat/completions` — 聊天补全

- 请求：OpenAI Chat Completions 体；从 body 提取 `model`、`stream`。
- 非流式：透传 JSON，解析 `usage`（含 `prompt_tokens_details.cached_tokens`）落统计。
- 流式（`stream:true`）：`Content-Type: text/event-stream` 逐块透传，首块记 TTFT；旁路解析末尾 usage chunk。
- 响应头：`X-Aya-Request-Id`；流式加 `Cache-Control: no-cache`、`X-Accel-Buffering: no`。

请求示例（客户端视角，与官方一致）：
```json
{ "model": "qwen2.5-7b-instruct", "stream": true,
  "messages": [{"role":"user","content":"你好"}],
  "stream_options": { "include_usage": true } }
```

### A3. `POST /v1/completions` — 文本补全（P1）

同 A2 语义，OpenAI Legacy Completions 体；`model` 路由，流式透传。

### A4. `POST /v1/embeddings` — 向量（P1）

透传；统计记 `prompt_tokens`（来自 usage），无 token 输出。

### A5. `POST /v1/images/generations` — 图片生成

- JSON 请求透传；`model` 路由（kind=image）。
- 统计摘要记 `n`、`size`、`response_format`；token 不适用（记 0，`req_summary` 存图片参数）。
- 响应透传（b64_json 或 url）。
- cli 型后端（如 sd.cpp 的 sd-cli）：网关解析 `prompt`/`size`/`n`/`seed` 注入命令占位符
  （`{prompt}` `{width}` `{height}` `{seed}` `{batch_count}` `{output_pattern}`），spawn 生成 PNG 后
  以 OpenAI images JSON（`data[].b64_json`）返回。
- Turbo 加速（Qwen-Image-2.1-Turbo）：纯后端参数，网关无特判——蒸馏权重 +
  `--sigmas qwen-image-2.1-turbo --steps 8 --cfg-scale 1.0 --sampling-method euler`
  （sigma 预设 = 1.0,0.978453,...,0.0，实际步数由 sigma 个数决定）。单独注册一个 cli 后端与
  模型名（如 `qwen-image-turbo`）即可与基础版并存、按 `model` 路由切换。

### A5b. `POST /v1/images/edits` — 图片编辑

- 两种请求形态，均路由到 kind=image 的 cli 后端：
  - **multipart/form-data**（OpenAI 官方形态）：`model` + `prompt` + `image`（可多个 `image[]`）
    文件部分，可选 `n`/`size`/`seed`/`negative_prompt` 字段；受 `max_upload_bytes` 限制。
  - **JSON**：`prompt` + `image`（base64 字符串或其数组，兼容 `data:image/...;base64,` 前缀）。
- 参考图落盘临时目录后经 `{ref_image}` 占位符注入命令（sd.cpp 为 `-r`，多张展开为
  `-r a.png -r b.png`，顺序保持）；请求无参考图时该 flag 连同占位符一并剔除，
  同一后端可同时服务 generations。
- 响应与 A5 相同（`data[].b64_json`）；`req_summary` 额外记 `ref_images` 张数。
- Qwen-Image-2.1 编辑要求：文本编码器需带 vision tower（safetensors int8_convrot 自带；
  GGUF 文本编码器需配套 `--llm_vision` mmproj）。分辨率取 `size`，建议 32 的倍数。

### A6. `POST /v1/audio/transcriptions` — ASR（语音转文字）

- **multipart/form-data**：`file`（音频）+ `model` + 可选 `language`/`prompt`/`response_format`/`temperature`。
- 网关用 busboy 边读边取 `model` 字段路由，`file` 流式转发（受 `max_upload_bytes` 限制，超限 413）。
- 响应透传（json/text/srt/vtt/verbose_json）。统计：`req_summary` 记音频字节数与（若可得）时长，token 记 0。

### A7. `POST /v1/audio/translations` — 语音翻译（P2）

同 A6。

### A8. `POST /v1/audio/speech` — TTS（文字转语音）

- JSON 请求（`model`、`input`、`voice`、`response_format`、`speed`）透传。
- 响应为**二进制音频流**（`audio/mpeg|wav|...`），边收边发，累计 `resp_bytes`。
- 统计：`req_summary` 记 `input` 字符数、`voice`、`response_format`；token 记 0。
- cli 型后端：`voice` 传自定义音色 id 或 name（见 A8b），网关把音色样本经 `{speaker_file}` 占位符注入命令。

### A8b. 自定义音色（OpenAI custom voices 风格）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/audio/voices` | multipart 上传：`name`（必填）、`audio_sample`（音频样本文件，必填）、`consent`（可选）。返回 voice 对象 `{id, object:"audio.voice", created_at, name, type:"audio_sample"}` |
| GET | `/v1/audio/voices` | 音色列表 `{object:"list", data:[...]}` |
| POST | `/v1/audio/voices/{id}` | JSON `{name}` 改名 |
| DELETE | `/v1/audio/voices/{id}` | 删除（连同样本文件） |

样本存 `data/voices/<id>.<ext>`，元数据在 SQLite `voices` 表。`/v1/audio/speech` 的 `voice` 按 id 精确匹配，未命中再按 name（大小写不敏感）；都不存在 → 404 `voice_not_found`。

### A9. `GET /healthz` — 健康检查（不鉴权）

```json
{
  "status": "ok",
  "uptime_s": 3600,
  "backends": [
    { "name": "qwen-vllm", "state": "ready", "inflight": 2, "idle_remaining_ms": 540000 },
    { "name": "whisper-local", "state": "stopped", "inflight": 0 }
  ]
}
```
`status`：任一后端 `crashed` → `degraded`；否则 `ok`。（供探活，不阻断流量。）

---

## B. 管理 / 统计接口（`/api/v1/*`）

供前端看板与运维使用；启用鉴权时需 Bearer Key 或有效登录会话。时间参数统一用**毫秒时间戳** `from`/`to`，缺省 `to=now`、`from=now-7d`。

### B0. 看板登录（`ui_auth` 配置后启用）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | 不鉴权。JSON `{username, password}`；成功下发 `Set-Cookie: aya_session=<64hex>; HttpOnly; SameSite=Lax; Max-Age=<ttl>` 并返回 `{status,user,expires_at}`；错误 401 `invalid_credentials` |
| POST | `/api/v1/auth/logout` | 清除会话 Cookie（幂等） |
| GET | `/api/v1/auth/me` | 鉴权。返回 `{ui_auth, user, via}`（via=session/api_key）；未登录 401 `session_expired`，前端据此弹登录页 |

会话为内存态（网关重启失效），TTL 由 `server.ui_auth.session_ttl` 控制（缺省 7d）；密码仅存 SHA-256 摘要，比较用 timingSafeEqual。前端任意管理请求收到 401 即回到登录页。

### B1. 后端与模型管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/backends` | 所有后端运行时状态 |
| POST | `/api/v1/backends/{name}/start` | 手动启动（process 型） |
| POST | `/api/v1/backends/{name}/stop` | 手动停止（drain 后停） |
| POST | `/api/v1/backends/{name}/restart` | 重启 |
| POST | `/api/v1/models/{name}/load` | **主动加载模型**（资源准入 + 必要时驱逐等待，见 B1a） |
| POST | `/api/v1/models/{name}/unload` | **主动卸载模型**（优雅 drain 后停止，可 force，见 B1a） |
| GET | `/api/v1/resources` | 设备内存快照、占用/预留与进行中加载任务（见 B1a） |
| GET | `/api/v1/models` | 配置视角的模型列表（含 kind、backend、enabled、别名） |
| POST | `/api/v1/config/reload` | 触发配置热加载，返回 diff 摘要 |
| GET | `/api/v1/events?backend=&limit=100` | 最近后端事件（start/stop/crash/idle_stop） |

`GET /api/v1/backends` 响应：
```json
{ "backends": [
  { "name": "qwen-vllm", "type": "process", "state": "ready",
    "inflight": 1, "queued": 0, "uptime_ms": 120000,
    "last_activity_ms": 1730000000000, "idle_remaining_ms": 540000,
    "idle_timeout_ms": 900000,
    "counters": { "starts": 3, "stops": 2, "crashes": 0, "idle_stops": 2 } }
]}
```
`idle_remaining_ms` = `idle_timeout - (now - last_activity)`，前端「闲置倒计时」直接用。

### B1a. 模型主动加载 / 卸载（资源感知）

#### `POST /api/v1/models/{name}/load?wait=true&timeout_ms=600000`

主动为该模型对应后端加载模型：资源准入（不足则按策略**等待既有模型闲置并卸载腾挪**）→ 启动进程 → 等待就绪。请求触发的 auto_start 与崩溃重启走同一准入。

- 幂等：已 `ready` → 200 `already_loaded`；`starting`/`evicting` 中 → 202，请求**附加到进行中的加载任务**（不重复启动）。
- `wait=true`（默认）：阻塞至就绪/失败/超时；超时但任务仍在进行 → **202**（任务后台继续，可轮询本接口或 B1）。`wait=false`：立即 202。
- remote 后端：200 `status:"noop"`（无进程可管理，仅健康确认）。

响应（200/202 同构）：

```json
{ "model": "qwen2.5-7b-instruct", "backend": "qwen-vllm",
  "status": "pending_resources",
  "resources": {
    "need_mb": 17408,                  // 声明 16384 + 安全余量 1024
    "free_mb": 6000, "total_mb": 65536
  },
  "waiting_for": [ { "backend": "whisper-local", "reason": "idle_inflight", "inflight": 1 } ]
}
```

`status` ∈ `ready | already_loaded | loading | pending_resources`；`waiting_for` 列出正在等待其闲置后卸载的后端。

失败（503，驱逐等待超时或无可驱逐候选）：

```json
{ "error": {
    "message": "insufficient memory: need 17408MB (incl. margin), free 6000MB; blocked by qwen-72b (mem 40000MB, evictable=false)",
    "type": "service_unavailable", "code": "resource_unavailable" } }
```

#### `POST /api/v1/models/{name}/unload?force=false`

主动优雅停止该模型对应后端（drain 进行中请求 → SIGTERM → 超时 SIGKILL），与闲置卸载同执行路径，事件 reason=`manual_unload`；`force=true` 跳过 drain 等待。

```json
{ "model": "whisper-large-v3", "backend": "whisper-local", "status": "stopping",
  "affects_models": ["whisper-large-v3", "whisper-small"] }
```

- 后端服务多个模型时 `affects_models` 提示影响面（卸载以**后端**为粒度）。
- 该后端存在进行中的加载任务 → 409 `load_in_progress`。
- remote 后端 → 200 `status:"noop"`。

#### `GET /api/v1/resources`

```json
{ "ts": 1729600000000,
  "mem": { "total_mb": 65536, "free_mb": 24000 },   // free=MemAvailable 语义（统一内存）
  "reserved": [ { "backend": "qwen-vllm", "mem_mb": 17408, "phase": "running" } ],
  "load_ops": [ { "backend": "gufo-14b", "state": "evicting",
                  "victims": ["whisper-local"], "waiters": 2, "deadline": 1729600600000 } ] }
```

前端「设备内存面板」与「正在等待 xxx 模型闲置卸载」提示的数据源；`free_mb` 基于 MemAvailable（含可回收缓存），与 OOM 规避口径一致。

### B2. 统计概览

`GET /api/v1/stats/summary?from=&to=&model=&endpoint=`

```json
{
  "range": { "from": 1729000000000, "to": 1729600000000 },
  "requests": { "total": 1234, "ok": 1200, "fail": 34, "success_rate": 0.972 },
  "tokens": { "prompt": 900000, "completion": 210000, "total": 1110000, "cached": 300000 },
  "cache_hit_rate": 0.333,
  "latency_ms": { "avg": 820, "p50": 610, "p95": 2100, "p99": 3400 },
  "ttft_ms": { "avg": 180, "p95": 420 },
  "by_model": [ { "model": "qwen2.5-7b-instruct", "requests": 1000, "tokens": 900000 } ]
}
```

### B3. 趋势序列（图表）

`GET /api/v1/stats/series?from=&to=&granularity=hour&metric=requests&model=&endpoint=`

- `granularity` ∈ `minute|hour|day`（默认按范围自适应：≤2d→hour，≤31d→day，其余→hour）。
- `metric` ∈ `requests|latency|ttft|tokens|cache`（默认 `requests`；`latency`/`ttft` 返回 avg+p95）。

```json
{ "granularity": "hour", "metric": "requests",
  "series": [ { "bucket": 1729000800000, "value": 42 }, ... ] }
```
`metric=latency` 时点为 `{ "bucket":..., "avg":..., "p95":... }`；`tokens` 返回 `{bucket, prompt, completion}`。

### B4. 请求明细（分页 + 过滤）

`GET /api/v1/stats/requests?from=&to=&model=&endpoint=&status=ok|fail&stream=1&page=1&page_size=50`

```json
{ "total": 1234, "page": 1, "page_size": 50,
  "items": [
    { "request_id": "req_ab12...", "ts_start": 1729600000123, "model": "qwen2.5-7b-instruct",
      "endpoint": "chat", "backend": "qwen-vllm", "is_stream": true,
      "status_code": 200, "ok": true, "latency_ms": 730, "ttft_ms": 150,
      "total_tokens": 512, "cached_tokens": 128 }
  ] }
```
列表为**精简字段**；完整字段走 B5。

### B5. 单请求详情（下钻）

`GET /api/v1/stats/requests/{request_id}`

```json
{
  "request_id": "req_ab12...", "ts_start": 1729600000123, "ts_end": 1729600000853,
  "client_addr": "127.0.0.1", "key_id": "k1",
  "endpoint": "chat", "model": "qwen2.5-7b-instruct", "backend": "qwen-vllm",
  "is_stream": true, "status_code": 200, "ok": true, "error": null,
  "latency_ms": 730, "backend_ms": 700, "ttft_ms": 150,
  "prompt_tokens": 400, "completion_tokens": 112, "total_tokens": 512,
  "cached_tokens": 128, "tokens_estimated": false,
  "req_bytes": 812, "resp_bytes": 4096,
  "req_summary": { "max_tokens": 512, "temperature": 0.7 },
  "timeline_ms": { "queue": 0, "backend_start": 0, "backend_ttfb": 140, "total": 730 }
}
```
`timeline_ms` 供前端画「到达→排队→后端启动→首包→完成」时间线。

### B6. 后端维度统计

`GET /api/v1/stats/backends?from=&to=`

```json
{ "backends": [
  { "backend": "qwen-vllm", "starts": 3, "stops": 2, "crashes": 0, "idle_stops": 2,
    "requests": 1000, "uptime_ms": 5400000 }
]}
```

---

## C. 前端页面 ↔ 接口映射

| 页面 | 调用 |
|---|---|
| 总览 Overview | B2 summary（今日/7d/30d 切换） |
| 趋势 Trends | B3 series（请求量、延迟、token、模型占比） |
| 请求明细 Requests | B4 requests（过滤分页）→ 点击行 B5 详情下钻 |
| 后端状态 Backends | B1 backends（状态/闲置倒计时）+ B1a load/unload 按钮 + GET resources 内存面板 + B6 累计 + 手动 start/stop/restart |

自动刷新：Overview/Trends/Backends 默认 10s 轮询；时间范围为全局状态，切页保持。

---

## D. 状态码与错误码（网关侧）

| HTTP | type | code | 触发 |
|---|---|---|---|
| 400 | invalid_request_error | missing_model | 缺 `model` 或 JSON 非法 |
| 400 | invalid_request_error | endpoint_kind_mismatch | 接口与模型 kind 不符 |
| 401 | authentication_error | invalid_api_key | Bearer 缺失/错误（未启用 ui_auth 时） |
| 401 | authentication_error | invalid_credentials | 看板登录用户名/密码错误 |
| 401 | authentication_error | session_expired | 启用了 ui_auth 但会话 Cookie 缺失/过期 |
| 404 | invalid_request_error | model_not_found | 模型未配置/禁用 |
| 404 | invalid_request_error | backend_not_found | 管理接口后端名不存在 |
| 413 | invalid_request_error | payload_too_large | 上传超 `max_upload_bytes` |
| 429 | rate_limit_error | queue_full | 后端排队已满 |
| 502 | bad_gateway | backend_start_failed | 后端启动失败/超时 |
| 502 | bad_gateway | cli_failed | cli 型后端非零退出/超时/无产出 |
| 502 | bad_gateway | backend_degraded | cli 型后端输出命中 `fail_on_output`（如 GPU 不可用静默退回 CPU），已整组杀进程快速失败 |
| 502 | bad_gateway | upstream_stall | 上游空闲超时（无字节） |
| 503 | service_unavailable | backend_stopped | 后端未运行且 `auto_start=false` |
| 503 | service_unavailable | backend_draining | 后端正在优雅停止 |
| 504 | timeout | queue_timeout | 排队等待超时（含资源紧张等待腾挪超时） |
| 503 | service_unavailable | resource_unavailable | 加载资源不足且驱逐等待超时/无可驱逐候选（附阻塞详情） |
| 409 | invalid_request_error | load_in_progress | 目标后端存在进行中的加载任务 |

上游后端自身返回的 4xx/5xx 与错误体**原样透传**，不套用上表。

---

## E. 兼容性说明

- 目标：`openai` Python/Node SDK 仅改 `base_url` + `api_key` + `model` 即可用。
- 流式遵循 OpenAI SSE 帧格式（`data: {chunk}\n\n` … `data: [DONE]\n\n`），网关不改写帧内容。
- `usage` 依赖上游遵循 `stream_options.include_usage`；不支持的上游走本地估算并打 `tokens_estimated` 标记。
- 扩展字段（`context_length`、`X-Aya-Request-Id`、`/api/v1/*`）均为增量，不影响标准 OpenAI 客户端。
