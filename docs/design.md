# Aya 系统详细设计文档

- 版本：v0.3
- 日期：2026-10-14
- 关联：[需求文档](requirements.md) · [API 设计](api-design.md)
- 技术栈：Node.js ≥ 22 LTS + TypeScript 5（strict, ESM）
- 变更记录：v0.2 新增 §4.7 ResourceManager（资源探测/加载准入/驱逐等待）与 §4.8 主动加载/卸载接口设计，对应需求 §3.6
- 变更记录：v0.3 适配统一内存主机：资源维度收敛为仅系统内存（移除显存/nvidia-smi 探测，`required_memory.mem_mb` 单一字段）

---

## 1. 总体架构

```
                         ┌──────────────────────────────────────────────┐
   OpenAI SDK / curl     │                 Aya Gateway (Node)             │
  ───────────────────▶   │                                                │
   POST /v1/chat/...     │  ┌──────────┐  ┌───────────┐  ┌─────────────┐  │
   POST /v1/images/...   │  │ HTTP 层  │─▶│ 路由/鉴权 │─▶│ 转发引擎     │  │
   POST /v1/audio/...    │  │ Fastify  │  │ Model→    │  │ undici +    │  │
                         │  └──────────┘  │ Backend   │  │ stream pipe │  │
   GET / (统计前端)      │       │        └───────────┘  └──────┬──────┘  │
   GET /api/v1/stats/... │       │ 静态资源                     │          │
                         │       ▼                              ▼          │
                         │  ┌──────────┐              ┌────────────────┐  │
                         │  │ 统计/日志 │◀── 埋点 ─────│ BackendManager │  │
                         │  │ SQLite   │              │ 进程/健康/闲置  │  │
                         │  └──────────┘              └───────┬────────┘  │
                         └────────────────────────────────────┼──────────┘
                                                               │ spawn / HTTP
                                    ┌──────────────────────────┼─────────────────┐
                                    ▼                          ▼                 ▼
                            llama.cpp server            本机 strata/gufo     remote 上游
                            (托管进程, OpenAI API)      (托管进程)          (OpenAI 兼容)
```

分层职责：

| 层 | 模块 | 职责 |
|---|---|---|
| 接入层 | `http` | Fastify 实例、路由注册、鉴权中间件、统一错误、静态资源 |
| 路由层 | `router` | `model`/别名 → 后端解析，接口类型校验 |
| 转发层 | `proxy` | 请求透传、SSE/二进制流式回传、usage 提取、指标埋点 |
| 资源层 | `backend` | 后端状态机、进程拉起/停止、健康检查、闲置卸载、并发闸门 |
| 资源层 | `resource` | 系统内存探测（统一内存主机）、加载准入、OOM 预防驱逐 |
| 观测层 | `stats` | 请求日志、SQLite 落库、聚合查询、事件记录 |
| 配置层 | `config` | YAML 加载、zod 校验、热加载、配置快照 |

设计原则：**转发主链路零阻塞**——统计写入、日志落库全部异步化，任何观测层故障不得影响转发。

---

## 2. 目录结构

```
aya/
├─ package.json                # workspace root
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ config.example.yaml
├─ docs/
├─ packages/
│  ├─ core/                    # 纯逻辑，无 IO 副作用，易单测
│  │  └─ src/
│  │     ├─ config/            # schema(zod)、loader、默认值、校验
│  │     ├─ model/            # 类型定义：Backend/Model/RequestLog/Event
│  │     ├─ router/           # 模型解析、别名表、接口类型匹配
│  │     ├─ backend/          # 状态机、闲置判定纯函数、并发闸门
│  │     ├─ resource/         # 资源需求计算、驱逐候选排序、准入判定纯函数
│  │     └─ util/             # id 生成、时间、错误类型
│  ├─ server/                  # 运行时：Fastify、进程、undici、sqlite
│  │  └─ src/
│  │     ├─ index.ts           # 启动装配（composition root）
│  │     ├─ http/              # server、routes、auth、error-handler、static
│  │     ├─ proxy/             # forwarder、sse-usage-parser、metrics 埋点
│  │     ├─ backend/           # process-runner、health-checker、idle-reaper、manager
│  │     ├─ resource/          # mem-probe、admission、evictor、load-ops
│  │     ├─ stats/             # store(sqlite)、writer(异步队列)、queries、retention
│  │     └─ admin/             # /api/v1 管理 & 统计路由
│  └─ web/                     # React + Vite + ECharts 统计前端
│     └─ src/
│        ├─ pages/{overview,trends,requests,backends}
│        ├─ api/               # 调用 /api/v1/stats
│        └─ components/
└─ test/                       # 集成测试 + mock 后端
```

`core` 与 `server` 分离：状态机、闲置判定、路由解析等纯逻辑在 `core` 内可脱离进程/网络单测。

---

## 3. 核心数据模型（TypeScript）

```ts
// —— 配置 ——
type BackendType = 'process' | 'remote' | 'cli' | 'passthrough';
interface BackendConfig {
  name: string;
  type: BackendType;
  base_url: string;                 // 转发目标根，如 http://127.0.0.1:8100/v1
  command?: string;                 // process 型
  args?: string[];                  // 支持 {model_path} 等插值
  env?: Record<string, string>;
  cwd?: string;
  model_path?: string;
  health_check?: { path: string; interval_ms: number; expect_status?: number };
  start_timeout_ms: number;
  stop_grace_period_ms: number;
  idle_timeout_ms: number;          // 0 = 不自动停止
  auto_start: boolean;
  max_concurrency: number;
  queue_size: number;
  queue_timeout_ms: number;
  restart?: { max_retries: number; backoff_base_ms: number };
  auth?: { header: string; value: string };  // remote/passthrough 上游鉴权注入（显式头，优先级最高）
  api_key?: string;   // 上游 API Key：注入 Authorization: Bearer；auth 缺省时生效；两者都缺省则透传客户端 Authorization
  required_memory?: { mem_mb: number };  // 加载所需内存峰值（统一内存，准入检查用）
  priority?: number;            // 驱逐优先级，越大越不易被驱逐（默认 0）
  evictable?: boolean;          // 是否可作为腾挪牺牲者（默认 true，false=常驻）
}
interface ModelConfig {
  name: string;
  aliases?: string[];
  backend: string;
  kind: 'chat'|'completion'|'embedding'|'image'|'asr'|'tts';
  context_length?: number;
  max_tokens?: number;
  enabled: boolean;
}
interface ResourcesConfig {
  enabled: boolean;                 // 默认 true
  probe_interval_ms: number;        // 默认 5000
  safety_margin_mb: number;         // 安全余量，默认 1024
  evict_wait_timeout_ms: number;    // 默认 600000（10min）
  allow_evict_busy: boolean;        // 默认 false：不打断使用中的后端
}
interface AppConfig { server: ServerConfig; storage: StorageConfig; resources: ResourcesConfig; backends: BackendConfig[]; models: ModelConfig[]; }

// —— 运行时后端状态 ——
type BackendState = 'stopped'|'starting'|'ready'|'draining'|'crashed';
interface BackendRuntime {
  name: string;
  state: BackendState;
  proc?: ChildProcess;              // process 型
  pgid?: number;                    // 进程组 id（detached 后 = pid）
  inflight: number;                 // 进行中请求
  queued: number;                   // 排队等待
  lastActivityAt: number;           // 最后一次请求「结束」时间（闲置计时起点）
  startedAt?: number;               // 本次进程启动时间
  readyAt?: number;
  consecutiveHealthFails: number;
  restartAttempts: number;
  counters: { starts: number; stops: number; crashes: number; idle_stops: number };
}

// —— 资源与加载任务 ——
interface ResourceSnapshot {
  ts: number;
  mem_total_mb: number; mem_free_mb: number;  // free=MemAvailable 语义（统一内存，不单独探测显存）
}
interface LoadOp {                  // 一次加载任务（主动 load 或请求触发 auto_start 共用）
  id: string; backend: string;
  state: 'admitting'|'evicting'|'starting'|'done'|'failed';
  need: { mem_mb: number };
  victims: string[];                // 已选中等待其闲置后卸载的后端
  waiters: number;                  // 附加到本任务的等待者数
  started_at: number; deadline: number;
  error?: string;
}

// —— 请求日志 ——
interface RequestLog {
  request_id: string; ts_start: number; ts_end: number;
  client_addr: string; key_id?: string;
  endpoint: string; model: string; backend: string;
  is_stream: boolean;
  status_code: number; ok: boolean; error?: string;
  latency_ms: number; backend_ms: number; ttft_ms?: number;
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number;
  tokens_estimated: boolean;
  req_bytes: number; resp_bytes: number;
  req_summary?: Record<string, unknown>;   // 参数摘要，不含正文
}
```

---

## 4. 后端状态机与进程管理

### 4.1 状态机

```
        auto_start & 请求到达
  ┌─────────┐  spawn()   ┌──────────┐  health OK  ┌────────┐
  │ stopped │──────────▶│ starting │───────────▶│ ready  │
  └─────────┘            └──────────┘             └────────┘
       ▲                     │ start_timeout/          │  idle_timeout 到 / 手动 stop
       │                     │ spawn 失败               ▼
       │  进程退出        ┌─────────┐            ┌──────────┐
       └─────────────────│ crashed │◀───────────│ draining │
                         └─────────┘  进程异常    └──────────┘
                          │ 退避重启              等待 in-flight 归零
                          └────────▶ starting     → SIGTERM → (超时)SIGKILL
```

状态迁移全部集中在 `BackendManager`，用显式 `transition(state, event)` 表驱动，非法迁移抛错，便于测试与排障。

### 4.2 进程拉起（process 型）

- `spawn(command, args, { detached: true, cwd, env })` → 子进程成为**新进程组组长**，`pgid = child.pid`。
- 参数插值：`args` 中 `{model_path}`、`{port}` 等占位符由配置解析填充。
- stdout/stderr 归档到「按后端」的日志文件（`data/logs/<backend>.log`），增长策略由 `logs` 配置控制，默认按天切：跨天把旧文件另存为 `<backend>-YYYY-MM-DD.log` 并另起当天文件，超过 `keep_days` 的历史文件自动删除；`mode: run` 则每次拉起后端清空只留本次运行；任何模式下超过 `max_bytes` 都就地截断保留最新内容。归档写入失败只告警，不影响转发。
- 监听 `exit`：区分「主动 stop 触发的退出」与「意外退出」。意外退出 → `crashed`，记录事件，若 `restart.max_retries` 未用尽则按 `backoff_base_ms * 2^attempt` 退避重启，否则回到 `stopped`（下次按需拉起）。

### 4.3 停止（优雅卸载）

```
stop(reason):
  state = draining                 # 立即拒绝新请求（503）
  await waitInflightZero(stop_grace_period_ms)   # 等 in-flight 归零
  if process 型:
    kill(-pgid, SIGTERM)           # 杀整个进程组
    await waitExit(stop_grace_period_ms)
    if 仍存活: kill(-pgid, SIGKILL)
  state = stopped
  记录 event(reason)               # reason ∈ {idle, manual, config_removed, shutdown}
```

杀进程组（`-pgid`）是**释放内存的关键**：推理框架常有 worker 子进程，只杀父进程会残留内存占用（统一内存主机上 GPU 占用也归还同一内存池）。

### 4.4 健康检查

- `starting`：`start_timeout_ms` 内轮询 `base_url + health_check.path`，成功即 `ready`；超时 → 停止并 `crashed`。
- `ready`：每 `interval_ms` 检查一次，连续 `expect_status` 失败 N 次（默认 3）→ `crashed`。
- remote 型：仅做健康探测，不管理进程；`idle_timeout` 对 remote 型无意义（忽略）。

### 4.5 闲置卸载（核心需求）

闲置判定纯函数（`core/backend/idle.ts`，可单测）：

```ts
function shouldUnload(rt: BackendRuntime, now: number, cfg: BackendConfig): boolean {
  if (cfg.type !== 'process') return false;
  if (cfg.idle_timeout_ms <= 0) return false;
  if (rt.state !== 'ready') return false;
  if (rt.inflight > 0 || rt.queued > 0) return false;      // 有进行中/排队 → 非闲置
  return now - rt.lastActivityAt >= cfg.idle_timeout_ms;   // 计时起点=最后请求结束
}
```

- `IdleReaper` 每 `min(idle_timeout, 5s)` 扫描一次所有 `ready` 后端，命中即 `stop('idle')`。
- **粒度为后端**：一个后端服务多模型时，`lastActivityAt` 由该后端上任意模型请求刷新，任一活跃即不卸载。
- 「不处于工作状态」= `inflight==0 && queued==0 && state==ready`（正在加载/启动的 `starting` 天然不满足 `ready`，不会被卸载）。

### 4.6 并发闸门与排队

`BackendManager.acquire(name)` 返回一个「租约」：

```
acquire():
  if state==stopped: if !auto_start → 503; else start()   # start 必经 ResourceManager 准入（§4.7）
  if state==draining/crashed → 503
  if inflight < max_concurrency: inflight++; return lease
  if queued >= queue_size: → 503 (queue_full)
  排队等待，超过 queue_timeout_ms → 503 (queue_timeout)
lease.release(): inflight--; lastActivityAt = now; 唤醒队首
```

`lastActivityAt` 在 **release（请求结束）** 时刷新，与需求「计时以最后请求结束为起点」一致。

### 4.7 资源探测、加载准入与驱逐（ResourceManager）

**目标：任何进程启动前确认设备内存足够；不足时先等既有模型闲置并卸载腾挪，仍不足则明确失败，绝不「赌一把」启动导致 OOM。**

#### 4.7.1 资源探测（Probe）

主机为**统一内存**架构：CPU 与 GPU 共用同一内存池，llama.cpp、strata、gufo 等后端（含其 GPU 加速）都在同一池内分配，因此**只判定系统内存，不单独探测显存**。

- 数据源：`os.totalmem()` / `os.freemem()`（Linux 上取自 `/proc/meminfo` 的 `MemTotal` / `MemAvailable`——含可回收缓存，与 OOM 规避口径一致）。
- `ResourceProbe` 每 `probe_interval_ms`（默认 5s）刷新 `ResourceSnapshot`，同时供 `GET /api/v1/resources` 与前端内存面板展示。
- 预留扩展：快照与准入按「多维度资源」接口书写，日后若加入独立显存的异构卡，只需挂一个 gpu 维度 probe，主流程不动。

#### 4.7.2 加载准入（Admission）

**一切进程启动入口**（主动 load、请求触发 auto_start、崩溃重启）统一经 `ResourceManager.acquireLoadPermit(backend)`：

```
required  = backend.required_memory.mem_mb + safety_margin_mb
available = snapshot.mem_free_mb − reserved_total      # 预留记账
fit       = available ≥ required

fit → 发放 permit，required 计入 reserved（并发 load 不会双双通过检查后合计 OOM）
      进程 ready 后预留转为「运行占用」，进程停止时释放
!fit → 进入驱逐流程
```

- **预留记账**是并发安全的关键：两个模型同时 load，各自检查时都「刚好够」，合计必 OOM；permit 未释放前第二个检查会看到 `reserved` 扣减。
- 崩溃重启同样过准入；拿不到 permit 则**保持 stopped** 并记事件 `restart_deferred_resource`，等下次请求或 load 再试——避免崩溃循环撞 OOM。

#### 4.7.3 驱逐等待（Eviction）

内存不足时构建 `LoadOp(state=evicting)`，同一后端的并发加载**合并**到同一任务（waiters 计数）：

```
candidates = { rt | rt.state==ready && cfg.evictable && rt.name != target }
             # allow_evict_busy=false（默认）时再要求 inflight==0 && queued==0
排序：priority 升序 → lastActivityAt 升序（低优先级、闲置最久者先牺牲）

loop（每 probe_interval 重查快照）:
  依序累加候选为 victims，模拟释放其占用后重算 fit
  fit 后逐个执行：等待 victim 闲置（in-flight 自然归零，不打断）→ stop('evict') → 释放其占用
  victims 全部停止且 fit → 发放 permit → LoadOp 进入 starting
  now > deadline(evict_wait_timeout) → 放弃：不再新增 victims，
    LoadOp=failed，返回 503 resource_unavailable + 阻塞详情
    （哪些后端占用多少、需要多少、可用多少、为何不可驱逐）
```

- **等待语义**：默认只等 victim 自然闲置（其新请求照常处理）；`allow_evict_busy=true` 时先对 victim `drain`（拒新请求）再等 in-flight 完成，腾挪更快但影响 victim 可用性。
- 驱逐卸载复用 §4.3 `stop(reason)` 路径，`reason='evict'`；`backend_events` 记录 `evict_stop`。
- 等待期间 `LoadOp` 状态（`pending_resources` + victims 列表）经 `GET /api/v1/resources` 与 backends 状态可查，前端可显示「正在等待 whisper-local 闲置卸载…」。
- 请求触发的 auto_start 走同一准入：请求在租约处等待（受 `queue_timeout` 约束），超时返回 504 `queue_timeout`（错误信息附「资源紧张，等待腾挪中」）。

### 4.8 主动加载 / 卸载接口（模型级）

管理 API 的模型级操作，解析 `model → backend` 后落到 BackendManager：

```
loadModel(name, wait, timeout):
  backend = resolve(name)                       # 404 model_not_found
  if backend.type=='remote' → 200 noop（仅健康确认）
  op = loadOps.get(backend) ?? create(backend)  # 并发合并
  op.waiters++
  admission(§4.7) → evicting? → starting → ready
  wait=true：阻塞至 done/failed/timeout；timeout 而仍在进行 → 202（任务后台继续）
  wait=false：立即 202 + 当前状态

unloadModel(name, force):
  backend = resolve(name)
  if loadOps.has(backend) → 409 load_in_progress
  if backend.type=='remote' → 200 noop
  stop(backend, reason='manual_unload', skipDrain=force)
  202 { status:'stopping', affects_models:[该后端全部模型] }   # 后端服务多模型时提示影响面
```

- 与闲置卸载、手动 stop 的区别仅在 `reason` 与入口校验；执行路径同为 §4.3 优雅停止。
- `stop` 的 reason 全集：`idle | manual | manual_unload | evict | config_removed | shutdown`。

---

## 5. 转发引擎（proxy）

### 5.1 请求处理管线

```
HTTP 请求
  │ 1. 生成 request_id，记录 ts_start、client_addr、key_id
  │ 2. 鉴权（启用时校验 Bearer）
  │ 3. 解析 model（JSON body 或 multipart 的 model 字段）→ 路由到 backend；kind 与 endpoint 校验
  │ 4. acquire(backend) 租约（可能触发冷启动，请求在此等待就绪）
  │ 5. undici.request 转发（透传 body 流 + 白名单请求头 + 注入上游鉴权）
  │ 6. 回传：按响应类型分流（见 5.2），记录 ttft（首个携带 token 的帧；首字节另记 timeline.first_byte）
  │ 7. 结束：release 租约；组装 RequestLog 投递到异步 writer
```

**透传原则**：请求体以流的形式直接 pipe 给上游，**不反序列化整个 body**（大文件/长上下文不落内存）。仅在需要读 `model` 时做**有限解析**：
- JSON 接口：流式读取头部若干 KB 提取 `model`/`stream` 字段后，将「已读字节 + 剩余流」重新拼成流转发（用一个小 `PrefixReader` 缓冲前缀，不破坏流式）。
- multipart（ASR）：`model` 是普通表单字段，用 `busboy` 边读边取 `model` 字段值，文件部分继续流式转发。

### 5.2 响应回传分流

| 响应类型 | 判定 | 处理 |
|---|---|---|
| SSE 流式（chat/completion） | `Content-Type: text/event-stream` 或请求 `stream:true` | 逐 chunk `reply.raw.write` 透传，**不缓冲**；旁路解析 `data:` 行提取 usage 与统计 token（见 5.3）；**首个携带 token 的帧**记 TTFT（`delta:{role}` 起始帧与 `: ping` 心跳不计数） |
| 二进制流（TTS） | `audio/*` | 直接 pipe，边收边发，累计 `resp_bytes` |
| 普通 JSON | 其余 | 透传 body；解析 `usage` 提取 token/cached_tokens |
| 错误 | 上游 4xx/5xx | 原样透传状态码与 body |

SSE 透传用 `pipeline(upstream.body, reply.raw)` 保证背压正确；旁路 usage 解析用 `Transform` 只**观察**不**改写**字节流。

### 5.3 usage / token 提取

- 非流式：解析响应 `usage.{prompt_tokens, completion_tokens, total_tokens}` 与 `usage.prompt_tokens_details.cached_tokens`。
- 流式：约定上游在最后一个 SSE chunk 带 `usage`（OpenAI `stream_options.include_usage` 语义）；旁路解析器在流结束前捕获该 chunk 的 usage。
- 兜底：上游无 usage 时，chat 类用 `gpt-tokenizer` 对请求 messages 估算 prompt tokens、对累积输出估算 completion tokens，置 `tokens_estimated=true`；ASR 记音频字节/时长，TTS 记输入字符数，图片记张数。缓存命中率在无 usage 时记 0 并随 `estimated` 标记展示。

### 5.4 超时与取消

- 转发不设「总超时」（长生成合法），但设**空闲超时**：连续 `idle_response_timeout`（默认 120s）无任何字节 → 判定上游卡死，中断并记 `error=upstream_stall`。
- 客户端断连（`reply.raw` close）→ 中止上游请求（`AbortController`），已产生的日志照常落库（`ok=false, error=client_abort`）。

---

## 6. 统计与日志（stats）

### 6.1 异步写入（主链路零阻塞）

```
RequestLog ──▶ 内存有界队列(如 10k) ──▶ 后台批量事务写入 SQLite(WAL)
                     │ 队列满: 丢弃最旧并计数 dropped_logs（不阻塞转发）
```

写入用 better-sqlite3 事务批量提交（每 100 条或 200ms 刷一次）。进程退出时 flush 剩余队列（限时 2s）。

### 6.2 表结构

沿用需求 §6，补充索引与事件表：

```sql
CREATE TABLE request_logs(
  id INTEGER PRIMARY KEY, request_id TEXT UNIQUE, ts_start INT, ts_end INT,
  client_addr TEXT, key_id TEXT, endpoint TEXT, model TEXT, backend TEXT,
  is_stream INT, status_code INT, ok INT, error TEXT,
  latency_ms INT, backend_ms INT, ttft_ms INT,
  prompt_tokens INT, completion_tokens INT, total_tokens INT, cached_tokens INT,
  tokens_estimated INT, req_bytes INT, resp_bytes INT, req_summary TEXT
);
CREATE INDEX idx_rl_ts ON request_logs(ts_start);
CREATE INDEX idx_rl_model_ts ON request_logs(model, ts_start);
CREATE INDEX idx_rl_ep_ts ON request_logs(endpoint, ts_start);
CREATE INDEX idx_rl_ok ON request_logs(ok, ts_start);

CREATE TABLE backend_events(
  id INTEGER PRIMARY KEY, ts INT, backend TEXT,
  event TEXT,          -- start|ready|stop|crash|idle_stop|health_fail|restart
  reason TEXT, detail TEXT
);

CREATE TABLE log_meta(key TEXT PRIMARY KEY, value TEXT);  -- schema 版本、dropped 计数等
```

### 6.3 聚合查询

MVP 直接在 `request_logs` 上按时间范围 + 粒度实时聚合（SQLite 对百万级 + 索引足够快），避免预聚合表的一致性复杂度：

- 分桶：`strftime('%Y-%m-%dT%H:00:00', ts_start/1000, 'unixepoch')` 按粒度格式化。
- 分位数：SQLite 无原生 percentile，MVP 用「取区间内延迟数组在应用层算 P50/P95/P99」或 `NTILE` 近似；数据量大时再引入 `stats_hourly` 预聚合（M5 优化项）。
- 缓存命中率：`SUM(cached_tokens)/NULLIF(SUM(prompt_tokens),0)`。

查询接口形态见 [api-design.md](api-design.md)。

### 6.4 保留与清理

后台每日任务：删除 `ts_start < now - retention_days` 的记录；`VACUUM`（或 auto_vacuum）控制体积。

---

## 7. 配置加载与热加载

- 启动：读 `--config`（默认 `./config.yaml`）→ zod 校验（失败即退出并打印精确路径错误）→ 构建 `AppConfig` 快照 → 装配各模块。
- 快照不可变：`ConfigStore` 持有当前快照；热加载生成新快照后**原子替换引用**，进行中的请求继续用旧快照，避免半更新。
- 热加载（chokidar 监听 + `POST /api/v1/config/reload`）：
  - 新增后端/模型：立即可路由；
  - 删除后端：对其 `stop('config_removed')`（drain 后停）；
  - 修改后端命令/端口：标记 `pending_restart`，drain 完当前 in-flight 后按新配置重启；
  - 修改模型参数（context_length 等）：新快照直接生效。
- 校验期交叉检查：`model.backend` 必须存在；`base_url` 合法；process/cli 型必须有 `command`；remote 型必须有 `base_url`。
- cli 型后端：无常驻进程/健康检查/闲置卸载；每请求 spawn 一次性命令（args 支持 `{input_file}`/`{output_file}`/`{output_pattern}`/`{speaker_file}` 及
  image 端点的 `{prompt}`/`{width}`/`{height}`/`{seed}`/`{batch_count}` 占位符），
  产出文件按 `output_content_type` 回传；`max_concurrency` 限并发，`required_memory` 经资源准入（并发共享一份预留），`cli_timeout` 超时杀进程组。
  另支持 `fail_on_output`（子串列表，不区分大小写）：stdout/stderr 命中即认定后端降级运行（典型是 GPU 初始化失败静默退回 CPU，
  单次耗时涨两个数量级），立刻整组杀掉并返回 502 `backend_degraded` 附原始行，避免陪跑满 `cli_timeout` 后只留下一个无信息量的超时。

---

## 8. 鉴权与安全

- `server.api_keys` 为空 → 不鉴权（本地默认）；非空 → 校验 `Authorization: Bearer`，命中即记 `key_id`（key 的短哈希，不落明文）。
- 管理台与 `/api/v1/*`：启用鉴权时同样要求合法 Key（需求开放问题 6 默认）。
- 隐私：`req_summary` 只存参数摘要（`max_tokens`/`temperature`/图片尺寸/音频时长等），**不存** messages 正文、图片数据、音频数据。失败请求例外：`proxy.log_raw_on_error`（默认开）会把请求体与上游错误响应的**头部**（`raw_log_max_bytes`，默认 8KB 截断）记入 `req_raw`/`resp_raw` 供排障，可在配置关闭。
- 默认 `listen` 建议 `127.0.0.1`；对外暴露由用户显式改配置或走反代。

---

## 9. 关键时序

### 9.1 冷启动聊天请求（流式）

```
Client        Gateway                    BackendManager        llama.cpp(未运行)
  │ POST /v1/chat/completions stream=true
  ├──────────▶│ 鉴权/解析 model=qwen
  │           │ acquire(qwen) ─────────▶│ state=stopped → spawn ──▶ 启动进程
  │           │                          │ starting: 轮询 /health ...
  │           │  (请求在租约处等待就绪)   │ health OK → ready
  │           │◀─────────────────────────┤ lease
  │           │ undici 转发 body 流 ─────────────────────────────▶ 推理
  │◀─ SSE chunk ─┤◀── 逐块透传 ────────────────────────────────────┤  (记 TTFT=首个 token 帧)
  │◀─ SSE chunk ─┤  旁路解析 usage
  │◀─ [DONE] ───┤ 流结束: 解析 usage → 组装 RequestLog → 异步落库
  │           │ release: inflight--, lastActivity=now
```

### 9.2 闲置卸载

```
IdleReaper(tick) → 遍历 ready 后端 → shouldUnload? → stop('idle')
  draining(拒新) → in-flight 归零 → kill(-pgid,SIGTERM) → 退出 → stopped → event(idle_stop)
```

### 9.3 主动加载（资源不足 → 等待闲置 → 驱逐腾挪）

```
Client          Admin API          ResourceManager              victim 后端 aA        目标后端 bB
  │ POST /api/v1/models/B/load (wait=true)
  ├──────────────▶│ resolve B→bB, acquireLoadPermit(bB)
  │               ├────────────────▶│ probe: mem free 6G < need 16G+1G(margin)
  │               │                 │ 选 victims=[aA]（evictable、priority 低、闲置 12m）
  │               │◀─ LoadOp(evicting, victims=[aA]) ─┤
  │◀─ 202 pending_resources ────────┤ （wait=true 时内部轮询至终态或超时）
  │               │                 │ aA.inflight==0 → stop('evict') ─▶ SIGTERM→stopped
  │               │                 │ 重查: mem free 22G ≥ 17G → permit(预留 17G)
  │               │◀─ permit ───────┤                 │                │ spawn→ready
  │◀─ 200 {status:"ready"} ─────────┤
  （deadline 内仍不足 → 503 resource_unavailable + 阻塞详情；已选 victims 不再扩大）
```

---

## 10. 错误处理与错误码

| 场景 | HTTP | type | code |
|---|---|---|---|
| 缺 model / 非法 JSON | 400 | invalid_request_error | missing_model |
| 模型未配置/禁用 | 404 | invalid_request_error | model_not_found |
| 接口类型与模型 kind 不符 | 400 | invalid_request_error | endpoint_kind_mismatch |
| 后端 auto_start 关闭且未运行 | 503 | service_unavailable | backend_stopped |
| 后端启动失败/超时 | 502 | service_unavailable | backend_start_failed |
| 排队满 | 429 | rate_limit_error | queue_full |
| 排队超时 | 504 | timeout | queue_timeout |
| 上游卡死（空闲超时） | 502 | bad_gateway | upstream_stall |
| 客户端断连 | — | — | client_abort（仅日志） |
| 加载资源不足且驱逐等待超时 | 503 | service_unavailable | resource_unavailable |
| 卸载/操作时后端存在进行中加载任务 | 409 | invalid_request_error | load_in_progress |

网关错误统一 `{"error":{"message","type","code","param"}}`；上游错误原样透传。

---

## 11. 测试策略

| 层 | 手段 |
|---|---|
| 纯逻辑（core） | vitest 单测：状态机迁移、`shouldUnload`、路由/别名解析、配置校验、usage 解析 |
| 转发 | 内置 **mock OpenAI 后端**（一个可编程 Node 服务）：返回固定/流式/错误/慢响应，验证透传、SSE、usage、TTFT、multipart |
| 进程管理 | 用 `/bin/sleep`、`/bin/sh -c 'trap ... TERM'` 等假进程验证 spawn/优雅停止/进程组回收/崩溃重启/闲置卸载 |
| 资源准入 | 注入假 `ResourceSnapshot` + 假后端：验证 fit 判定、驱逐候选排序（priority→闲置时长）、等待闲置、deadline 失败、并发 load 预留记账不超卖 |
| 统计 | 灌入已知 RequestLog，断言聚合查询（请求数、P95、命中率）正确 |
| 端到端 | 起网关 + mock 后端，用 `openai` npm SDK 直连跑 chat 流式/非流式、TTS、ASR |

CI：`pnpm -r test`（vitest）+ `pnpm -r build` + `tsc --noEmit`。

---

## 12. 可配置项默认值汇总

| 配置 | 默认 |
|---|---|
| `server.listen` | `127.0.0.1:8000` |
| `storage` | sqlite `./data/aya.db`，`retention_days: 90` |
| `backend.start_timeout_ms` | 300000（5min，大模型加载） |
| `backend.stop_grace_period_ms` | 60000 |
| `backend.idle_timeout_ms` | 900000（15min），0 关闭 |
| `backend.max_concurrency` | 8 |
| `backend.queue_size` | 64 |
| `backend.queue_timeout_ms` | 120000 |
| `proxy.idle_response_timeout_ms` | 120000 |
| `proxy.max_upload_bytes` | 104857600（100MB，ASR/图片） |
| 统计写入队列 | 10000，批量 100 条 / 200ms |
| `resources.enabled` | true |
| `resources.probe_interval_ms` | 5000 |
| `resources.safety_margin_mb` | 1024 |
| `resources.evict_wait_timeout_ms` | 600000（10min） |
| `resources.allow_evict_busy` | false |
| `backend.priority` / `evictable` | 0 / true |

---

## 13. 实现顺序（对应需求里程碑）

1. **M1**：`core/config` + `core/router` + `server/http` + `proxy`（chat/images/tts/asr 透传 + SSE）+ mock 后端跑通 SDK 直连。
2. **M2**：`backend/*`（process-runner、health、idle-reaper、manager、并发闸门）+ `resource/*`（probe、admission、evictor、load-ops）+ 模型 load/unload API + 假进程/假快照测试。
3. **M3**：`stats/*`（writer、store、queries、retention）+ 埋点接入转发。
4. **M4**：`admin/*` 统计 API + `web` 四页看板。
5. **M5**：鉴权、热加载、手动启停、Docker、文档。
