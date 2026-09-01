# 🍱 中午食什么大抽奖 · Cloudflare 全栈版（KV，无数据库）

**当前版本：v3.2.1（2026-08-29 20:27）** · Worker 名称：`lunch-app`

标准前后端部署：**Cloudflare Workers（后端 API）+ KV（共享存储）+ Assets（前端静态）+ MCP Server**。
**无数据库**：免建库、免建表、免迁移——KV namespace 已建好并预填进配置，部署只剩 `wrangler deploy` 一步。

新增：今日抽奖记录按 **运气值由大到小** 自动排序，运气徽章显示在玩家名字前方。修复「清空」按钮：前端会调用后端 `DELETE /api/records` 真正删除当日记录。

## 📌 版本号怎么看（三处均可查）
- **页面页脚**：打开前端页面，底部直接显示 `前端 vX · 后端 vX`（不一致会有 ⚠️ 提示）
- **API**：`GET /api/version` 返回 `{version, build, storage}`；所有 API 响应头带 `X-App-Version`
- **MCP**：`get_version` 工具；`initialize` 的 `serverInfo.version`

## 版本历史
| 版本 | 日期 | 变更 |
|---|---|---|
| v3.2.1 | 2026-08-29 20:27 | **修复清空按钮**：点击后前端调用后端 `DELETE /api/records` 真正删除当日记录（之前只是重新加载，未删除），删除后即时刷新名单与记录区 |
| v3.2.0 | 2026-08-29 20:07 | **记录区改版**：运气值徽章移至玩家名字前方并放大加粗；记录清单按运气值 **由大到小** 降序排列；无运气值的旧记录自动沉底；排序与显示即时刷新 |
| v3.1.2 | 2026-08-29 20:00 | **KV id 预填**：lunch_kv 的真实 namespace id（`980b3ca6...07ec0`）已写入 wrangler.toml，解压后直接 `wrangler deploy`，无需再创建/替换 |
| v3.1.1 | 2026-08-29 19:52 | **部署配置修正**：Worker 改名 lunch-app；修复 KV id 占位值 `"local"` 导致线上部署报 `[code: 10042]` 的问题（deploy.sh 自动创建/回填真实 id）；README 加部署排错章节 |
| v3.1.0 | 2026-08-29 19:39 | **新功能：今日运气值**——抽完餐厅自动接续掷 D10 骰子（滚动动画），定格显示 1-10 分 + 评语（1-3 運勢不佳 / 4-7 運勢普通 / 8-10 鴻運當頭）；运气分随记录一起存云端，记录行显示运气徽章；MCP spin 同步掷运气 |
| v3.0.0 | 2026-08-29 18:46 | **架构切换：D1 → KV**（去掉数据库）；免建库/免建表/免迁移，部署从 4 步减到 2 步；当日记录 30 天自动过期清理 |
| v2.1.1 | 2026-08-29 16:56 | 版本递增交付批次：功能与 v2.1.0 一致，build 时间戳精确到分钟以便区分不同构建 |
| v2.1.0 | 2026-08-29 | 版本号体系上线（页脚 + /api/version + MCP get_version + 响应头）；已抽名字按钮立刻 ✓ 置灰（抽完即时反馈，无需刷新） |
| v2.0.0 | 2026-08-28 | Cloudflare 全栈版：Workers + D1 共享库 + MCP Server，团队同一份数据 |
| v1.3.1 | 2026-08-29 | 纯前端版：已抽名字 ✓ 置灰 + 版本页脚（workbuddy.link 线上版对应此代） |
| v1.3.0 | 2026-08-28 | 名字单选（10人）+ 每日限抽 + 今日记录（纯前端 localStorage 版） |
| v1.2.0 | 2026-08-28 | 用 Lunch list.xlsx 完全替换为 11 家常去餐厅 |
| v1.1.0 | 2026-08-26 | 澳门餐厅清单版（18 家） |
| v1.0.0 | 2026-08-26 | 初版轮盘（通用办公室菜单，纯前端） |

> 以后每次生成/修改都会递增版本号并更新此表。

## 架构
```
浏览器 ── REST ──> Cloudflare Workers  (/api/menu, /api/draw, /api/records)
                         │
                         ├─ KV (lunch_kv)     共享菜单 + 今日抽奖记录（团队同一份）
                         │    ├─ menu                菜单 JSON
                         │    └─ records:YYYY-MM-DD  当日记录 + 运气分（30 天自动过期）
                         └─ /mcp                MCP Server（spin / get_menu / record_draw / get_records）

AI / MCP Client ── JSON-RPC ──> /mcp   与前端共用同一份后端数据
```

抽奖流程：选名字 → 转盘抽餐厅 → 弹窗内自动接续 D10 骰子滚动 → 定格显示运气分 + 评语 → 记录（餐厅 + 运气分）入云端，与历史记录并列显示。

关键价值不变：菜单与「每人每天限抽一次」的记录在**云端 KV**，前端和 MCP 看到的是同一份数据——
纯前端版各看各的 localStorage、团队记录不同步的痛点依旧被解决，但不再需要维护数据库。

### 为什么 KV 够用（也说明它的边界）
- **额度**：免费版每天 1000 次写 / 10 万次读。本应用每天最多几十次写（10 人 × 1 抽 + 偶尔改菜单），余量巨大
- **无 schema**：KV 是键值存储，无需建表和迁移
- **一致性**：KV 跨节点传播最多约 60 秒。同一办公室的同事大概率打到同一边缘节点，感知不到；极端情况下 A 抽完 1 分钟内 B 在别的节点看到的记录可能短暂少一条，随后自动一致
- **并发**：两个请求同一毫秒同时写当日记录，理论上有极小概率互相覆盖（KV 无事务）。10 人团队午休场景概率可忽略
- **保留期**：当日记录写入时设置 30 天 TTL，到期由 KV 自动清理，不用手动维护

## 文件结构
```
cloudflare-lunch/
├── wrangler.toml          # 部署配置（Workers + KV + Assets）
├── package.json           # npm scripts（dev / deploy）
├── deploy.sh              # 一键部署脚本（填入 Token 后 bash deploy.sh）
├── README.md              # 本文档
├── .gitignore
├── worker/
│   └── index.js           # 后端：REST 路由 + KV 读写 + 手写 MCP(JSON-RPC)
└── public/
    └── index.html         # 前端：轮盘 UI（数据走 /api/*）
```

（v2.x 的 migrations/ 目录已随 D1 一起移除）

## 本地开发（无需 Cloudflare 账号）
```bash
npm i -g wrangler
cd cloudflare-lunch
wrangler dev        # http://localhost:8787，KV 自动本地模拟
```
首次访问会自动把 11 家默认餐厅 seed 进 KV。

## 部署到 Cloudflare（需 API Token + Account ID）

> **本包的 KV namespace id 已预填**（lunch_kv：`980b3ca603e94e11aeda92a440b07ec0`），无需再创建/替换，直接部署即可。

**方式 A：一键脚本（推荐）**
```bash
cd cloudflare-lunch
# 编辑 deploy.sh 顶部，把 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 填好
bash deploy.sh
```
脚本会检测到 KV id 已是真实值，直接执行部署（换绑其他 namespace 时才会自动创建/回填）。

**方式 B：手动（一步）**
```bash
export CLOUDFLARE_API_TOKEN=xxx
export CLOUDFLARE_ACCOUNT_ID=yyy
cd cloudflare-lunch
wrangler deploy
```

部署后 Cloudflare 给一个 `*.workers.dev` 域名（或绑定自定义域），前端、REST、MCP 全在上面。

### ⚠️ 常见部署错误

**`KV namespace 'local' is not valid. Please verify the namespace_id in your configuration. [code: 10042]`**

根因：`wrangler.toml` 的 `[[kv_namespaces]]` 段里 KV id 不是合法的 32 位十六进制 namespace id（比如本地占位值 `"local"`）。部署流程分两步——先上传静态资产（不校验 KV 绑定，所以 /index.html 上传成功），再调 `workers/scripts/<name>/versions` 创建 Worker 版本（此时 Cloudflare API 校验所有绑定，发现 id 无效，拒绝发布）。

> 本包 v3.1.2 起已预填真实 id，正常情况下不会再触发此错误。若你在别的环境复用此工程，可按下面方法取回/重建 id：

```bash
# ① 推荐：一键脚本自动处理（检测到非法 id 时自动创建/查回并写回 wrangler.toml）
bash deploy.sh

# ② 手动新建
wrangler kv namespace create lunch_kv
#   输出形如：id = "1a2b3c4d...32位hex"，替换 wrangler.toml 里的 id 值

# ③ 已建过（账号里查回 id）
wrangler kv namespace list    # 找到 title 以 lunch_kv 结尾的条目，取其 id
```
注意：如果之前用 `name = "lunch-wheel"` 部署过，本次起 Worker 名为 **lunch-app**，首次会创建新 Worker（新 URL），旧的可在后台删除。

### API Token 权限要求
- **Account** → `Workers Scripts` → **Edit**
- **Account** → `Workers KV Storage` → **Edit**
获取路径：Cloudflare 后台 → 右上角头像 → My Profile → API Tokens → Create Token → Custom Token 勾这两项。
（v2.x 时代需要 D1 权限，现在不需要了）

### Account ID 获取
- Cloudflare 后台右下角侧栏「Account ID」
- 或 `wrangler whoami`（需先登录过一次）

## MCP 接入
端点：`POST <你的域名>/mcp`（JSON-RPC 2.0）。工具：

| 工具 | 说明 |
|---|---|
| `spin` | 从共享菜单加权随机抽一家 + 掷今日运气值（D10 1-10 分 + 评语）；传 `name` 则自动记录（含运气分）并遵守每日限抽 |
| `get_menu` | 返回当前共享菜单 |
| `record_draw` | 记录一次抽奖（name + restaurant + 可选 luck 1-10），每人每天限一次 |
| `get_records` | 返回某天（默认今天）的抽奖记录与运气分（KV 保存 30 天） |
| `get_version` | 查询当前部署版本号与构建日期 |

任何支持 Streamable HTTP MCP 的 client 配置该 URL 即可调用本服务抽奖、查记录。

### MCP Client 接入示例

**curl 直接调：**
```bash
curl -X POST https://lunch-app.<你的子域>.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Claude Desktop / Cursor 等支持 MCP 的客户端：**
配置文件加：
```json
{
  "mcpServers": {
    "lunch-app": {
      "type": "streamable-http",
      "url": "https://lunch-app.<你的子域>.workers.dev/mcp"
    }
  }
}
```
之后在对话里就能让 AI「给 ted 抽一下中午吃啥」「看看今天谁抽了什么」。
