# Aya — AI 模型请求转发管理与统计系统

本地/私有环境的 **AI 模型请求转发网关**：对外提供统一的 OpenAI 兼容 API，对内完成模型路由、后端进程托管（按需拉起 / 闲置卸载 / 崩溃重启）、资源感知加载（防 OOM）与请求统计看板。

详细设计见 [docs/requirements.md](docs/requirements.md) · [docs/design.md](docs/design.md) · [docs/api-design.md](docs/api-design.md)。

## 特性

- **OpenAI 兼容转发**：`/v1/chat/completions`（含 SSE 流式）、`/v1/completions`、`/v1/embeddings`、`/v1/images/generations`、`/v1/images/edits`（参考图 multipart 或 JSON base64，经 `{ref_image}` 占位符注入 CLI 后端如 sd-cli `-r`）、`/v1/audio/transcriptions`（multipart 流式）、`/v1/audio/speech`（二进制流透传）。请求体流式透传不缓冲，OpenAI SDK 只改 `base_url` + `model` 即可使用。
- **后端进程托管**：配置命令拉起 llama.cpp / vLLM / 任意自带 OpenAI API 的推理进程；健康检查、按需冷启动、闲置超时优雅卸载（杀进程组确保内存释放）、崩溃退避重启、并发闸门与排队。
- **纯转发上游（passthrough）**：把远程 OpenAI 兼容 API（如 `http://127.0.0.1:8731/v1`）直接挂为后端——不托管进程、不做健康探测，恒可服务，上游不可达快速失败。上游 api key 三种配法：`api_key: "sk-xxx"` 注入 Bearer（独立于网关自身 `api_keys`，可不同）；或 `auth` 显式头；或都不配——原样透传客户端的 Authorization（上游 key 同自身设置）。
- **资源感知加载（防 OOM）**：统一内存主机只判定系统内存（MemAvailable）；一切进程启动前做准入检查 + 并发预留记账；内存不足时按「低优先级 → 闲置最久」选择驱逐候选，等待其闲置后卸载腾挪；超时返回 503 `resource_unavailable` 附阻塞详情，绝不赌一把启动。
- **模型主动加载/卸载**：`POST /api/v1/models/{name}/load|unload`，支持同步等待与任务状态查询。
- **日志与统计**：每请求落库（TTFT、延迟、token、缓存命中、时间线），SQLite 存储 + 异步批量写入；聚合统计 API + 内置 React 看板（总览/趋势/明细下钻/后端状态与内存面板，顶栏统一自动刷新 5s/10s/30s/60s/关）。
- **运维**：API Key 鉴权（key 短哈希脱敏）、看板登录（`server.ui_auth` 用户名密码 + HttpOnly 会话 Cookie，与 API Key 并存任一放行）、配置热加载、结构化日志、`/healthz`；后端 stdout/stderr 归档按 `logs` 策略增长（默认按天切 + 保留 3 天 + 单文件 20MB 截断，可 `mode: run` 只留本次运行）。

## 快速开始

```bash
pnpm install
pnpm -r build
cp config.example.yaml config.yaml   # 模板内路径为 path/to/… 占位，换成本机实际路径
node packages/server/dist/index.js --config config.yaml
```

打开 `http://127.0.0.1:8000/` 查看统计看板；`/healthz` 健康检查。

客户端接入（与官方 OpenAI 用法一致）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-any")
client.chat.completions.create(model="qwen2.5-0.5b", messages=[{"role": "user", "content": "你好"}])
```

配置说明见 [config.example.yaml](config.example.yaml)（含 process / remote / passthrough / cli 四类后端与逐字段注释；填好本机路径后存为 `config.yaml`，该文件不入库）。

## 开发

```bash
pnpm -r test        # vitest：core 纯逻辑单测 + server 集成测试（mock 后端）
pnpm -r typecheck   # tsc --noEmit
pnpm --filter @aya/server dev   # tsx 热跑（读仓库根 config.yaml）
pnpm --filter @aya/web dev      # 前端 dev（代理到 8000）
```

目录结构：

```
packages/core     纯逻辑：配置 schema、路由、状态机、闲置判定、资源准入（可脱离进程单测）
packages/server   Fastify 网关：转发引擎、进程管理、资源管理、SQLite 统计、管理 API
packages/web      React + Vite + ECharts 统计看板（构建产物由网关静态托管）
```

## 端到端验证（真实小模型）

```bash
cp config-e2e.example.yaml config-e2e.yaml   # 填入本机 llama-server 与 gguf 路径
node packages/server/dist/index.js --config config-e2e.yaml
```

模板 [config-e2e.example.yaml](config-e2e.example.yaml) 配置了三个真实小模型后端（llama.cpp，CPU 模式；填好本机路径后另存为 `config-e2e.yaml`，该副本不入库）：

| 模型 | 后端 | 验证点 |
|---|---|---|
| Qwen2.5-0.5B-Instruct (q8) | qwen-chat | chat 冷启动、SSE 流式、别名 gpt-4o-mini、闲置 90s 卸载 |
| Qwen3-VL-Embedding-2B | embed | embeddings 冷启动、usage 统计 |
| Qwen3-ASR-1.7B | asr | multipart 音频上传流式转发 |

已验证：冷启动 2s 应答、流式逐块透传、闲置卸载后内存实际释放、OpenAI Python SDK 直连（models/chat/stream/embeddings）。

## Docker

```bash
docker build -t aya .
docker compose up
```

## 状态码与错误码

网关自身错误统一 OpenAI 风格 `{"error":{"message","type","code"}}`；上游错误原样透传。完整表见 [docs/api-design.md §D](docs/api-design.md)。
