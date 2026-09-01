#!/usr/bin/env bash
# 一键部署午餐大抽奖到 Cloudflare（v3.2.1 KV 版，无数据库）
# 使用：把下方两个变量填好，bash deploy.sh
#
# KV namespace id 处理逻辑：
#   - v3.1.2 起 wrangler.toml 已预填真实 id（lunch_kv → 980b...7ec0），直接部署
#   - 若检测到占位值/非法 id，自动创建（或查回已存在的）lunch_kv 并写回真实 id

set -e

: "${CLOUDFLARE_ACCOUNT_ID:?请先在脚本顶部填入 CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?请先填入 CLOUDFLARE_API_TOKEN（Workers Scripts:Edit + Workers KV Storage:Edit）}"

export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

cd "$(dirname "$0")"

# ---------- [1/3] 确保拿到真实 KV namespace id ----------
CURRENT_ID=$(grep -A3 'kv_namespaces' wrangler.toml | grep -oE 'id = "[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -1)

if [ -n "$CURRENT_ID" ]; then
  echo "▶ [1/3] wrangler.toml 已有真实 KV id = $CURRENT_ID，跳过创建"
else
  echo "▶ [1/3] 检测到 KV id 为占位值/非法值，开始创建或查回 namespace lunch_kv ..."
  KV_JSON=$(wrangler kv namespace create lunch_kv 2>&1 || true)
  echo "$KV_JSON"
  KV_ID=$(echo "$KV_JSON" | grep -oE '"id":\s*"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -1)
  # create 失败（namespace 已存在）时，从 list 里查回 id
  if [ -z "$KV_ID" ]; then
    KV_ID=$(wrangler kv namespace list 2>/dev/null \
      | python3 -c 'import json,sys
try:
    for ns in json.load(sys.stdin):
        if ns.get("title","").endswith("lunch_kv"):
            print(ns["id"]); break
except Exception:
    pass')
  fi
  if [ -z "$KV_ID" ]; then
    echo "✗ 拿不到 lunch_kv 的真实 id。请手动执行："
    echo "    wrangler kv namespace create lunch_kv"
    echo "  然后把输出中的 id 填到 wrangler.toml 的 [[kv_namespaces]] 段，再重跑本脚本。"
    exit 1
  fi
  # 把真实 id 写回 wrangler.toml（只替换 KV 段的 id 行）
  sed -i.bak -E "s/^(id = \")local(\".*)$/\1${KV_ID}\2/" wrangler.toml
  if ! grep -q "id = \"${KV_ID}\"" wrangler.toml; then
    sed -i.bak -E "s/^id = \".*\"/id = \"${KV_ID}\"/" wrangler.toml
  fi
  echo "✓ 已写入 KV id = $KV_ID"
fi

# ---------- [2/3] 部署 Workers + KV + 前端静态资源 ----------
echo "▶ [2/3] 部署 Workers + KV + 前端静态资源 ..."
wrangler deploy

# ---------- [3/3] 完成 ----------
echo "▶ [3/3] 完成 ✅"
echo ""
echo "提示："
echo "  • 前端页面：https://lunch-app.<你的子域>.workers.dev/"
echo "  • REST API：https://lunch-app.<你的子域>.workers.dev/api/menu"
echo "  • MCP 端点：https://lunch-app.<你的子域>.workers.dev/mcp"
echo "  • 验证版本：访问 /api/version 应返回 v3.2.1，页脚应显示 前端 v3.2.1 · 后端 v3.2.1 ✅"
