#!/bin/bash
# aya process 后端入口：halogen NPU 模型（XDNA NPU，与 GPU 无关）
# 复用 /mnt/ssd/code/halogen/run-npu.sh：halogen-npu 引擎 + serve_api OpenAI 前端。
# 每个后端跑单个模型（aya 后端 env 传 MODELS=<模型> / PORT / NPU_PORT）——
# 引擎的模型列表在 listen 启动参数里固定、无运行时增删，模型生命周期=进程生命周期，
# 这样 aya 的按需拉起/闲置卸载/资源准入/驱逐都是按模型粒度。
#
# 注意：多个 halogen-npu 进程可并存、可【串行】答题，但【并发答题会冲突】
# （XDNA command state 8，引擎崩溃）。同一时刻只应有一个 NPU 模型在答题。
#
# 为什么不直接跑 run-npu.sh：
#   aya 进程 memlock 硬限只有 8 MiB，NPU 引擎需 ≥512MB。run-npu.sh 自带的
#   systemd-run --user 自拉起有两个问题：瞬时服务不继承调用方环境（MODELS 等
#   环境变量丢失，只剩脚本默认 4 个模型）；unit 名随机，aya 杀进程组时服务会
#   成孤儿继续占 NPU/端口。本脚本代之以固定 unit 名（按端口区分，多后端互不
#   干扰）+ 显式传 env + trap 收尾，aya stop（kill 进程组）时一并停干净。
set -uo pipefail

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
export MODELS=${MODELS:-"decider-0.8b d3-nano embeddinggemma-2 qwen3-asr-1.7b qwen3-embedding-0.6b"}
export PORT=${PORT:-8732}
export NPU_PORT=${NPU_PORT:-8740}
export HALOGEN_API_KEY=${HALOGEN_API_KEY:-sk-npu-local}

UNIT=${UNIT:-aya-halogen-npu-$PORT}
# 上次异常退出可能残留瞬时服务（占端口/NPU），先清掉
systemctl --user stop "$UNIT.service" --no-block >/dev/null 2>&1

# --pty：服务输出经伪终端流回本脚本 stdout，进 aya 的日志归档；
# _NPU_WRAPPED=1 让 run-npu.sh 跳过它自己的 memlock 自拉起（本服务已有 infinity）
systemd-run --user --unit="$UNIT" --collect --pty --wait \
  -p LimitMEMLOCK=infinity \
  env _NPU_WRAPPED=1 MODELS="$MODELS" PORT="$PORT" NPU_PORT="$NPU_PORT" \
      HALOGEN_API_KEY="$HALOGEN_API_KEY" \
  /mnt/ssd/code/halogen/run-npu.sh &
CLI=$!

trap 'systemctl --user stop "$UNIT.service" 2>/dev/null; kill "$CLI" 2>/dev/null' TERM INT
wait "$CLI"; ec=$?
# 兜底：客户端被 SIGKILL 等异常路径退出时，把残留服务停干净释放 NPU
systemctl --user stop "$UNIT.service" >/dev/null 2>&1
exit $ec
