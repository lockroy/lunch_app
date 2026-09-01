// Cloudflare Workers 后端：REST API + KV 存储 + MCP Server
// 同时服务前端静态资源（ASSETS）、REST（/api/*）与 MCP（/mcp）
// v3.0.0 起弃用 D1：免建库、免建表、免迁移，数据存 Cloudflare KV

// ===== 版本号（每次生成/修改递增，页面与 API 均可见）=====
// v3.2.1  2026-08-29 20:27  修复「清空」按钮：前端调用后端 DELETE /api/records 真正清空当日记录（之前只是重新加载，未删除）
// v3.1.2  2026-08-29 20:00  KV namespace id 预填（lunch_kv → 980b...7ec0），解压即可 wrangler deploy，无需再手动替换
// v3.1.1  2026-08-29 19:52  部署配置修正：Worker 改名 lunch-app；修复 KV id 占位值 "local" 导致线上部署报 [code: 10042] 的问题（deploy.sh 自动创建/回填真实 id）
// v3.1.0  2026-08-29 19:39  新功能：抽完餐厅自动接 D10 今日运气值（1-10 分 + 评语），记录含运气分
// v3.0.0  2026-08-29 18:46  架构切换：D1 → KV（无数据库）；当日记录 30 天自动过期；部署少两步
// v2.1.1  2026-08-29 16:56  版本递增交付批次（功能同 v2.1.0，build 时间戳区分构建）
// v2.1.0  2026-08-29  版本号体系上线（页脚+API+MCP 可查）
// v2.0.0  2026-08-28  Cloudflare 全栈版（Workers+D1+MCP，团队共享数据）
// v1.3.0  2026-08-28  名字单选/每日限抽/今日记录（纯前端 localStorage 版）
// v1.2.0  2026-08-28  Lunch list.xlsx → 11 家常去餐厅
// v1.1.0  2026-08-26  澳门餐厅清单版
// v1.0.0  2026-08-26  初版轮盘（通用办公室菜单）
const VERSION = "v3.2.1";
const BUILD_DATE = "2026-08-29 20:27";

// KV 数据布局（binding: KV）
//   menu                → [{id,emoji,name,tags,weight}]  共享菜单
//   records:YYYY-MM-DD  → [{name,restaurant,date,time,ts,luck,label}]  当日抽奖记录（30 天自动过期）
const MENU_KEY = "menu";
const RECORD_TTL = 86400 * 30; // 记录 30 天后由 KV 自动清理

const DEFAULT_MENU = [
  { emoji: "🍲", name: "遠M", tags: [] },
  { emoji: "🍜", name: "近M", tags: [] },
  { emoji: "🍚", name: "孖寶", tags: [] },
  { emoji: "🍛", name: "新康記", tags: [] },
  { emoji: "🥟", name: "北方餃子", tags: ["餃子", "麵食"] },
  { emoji: "🍱", name: "一號", tags: [] },
  { emoji: "🍳", name: "新潮", tags: [] },
  { emoji: "🍣", name: "味藏", tags: [] },
  { emoji: "🍢", name: "𧙗街", tags: [] },
  { emoji: "🍗", name: "俊榮", tags: [] },
  { emoji: "🍜", name: "新鴻發 (連勝)", tags: [] },
];

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}
function nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,mcp-session-id",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "X-App-Version": VERSION, "X-Build-Date": BUILD_DATE, ...cors() },
  });
}

// ---------- KV：菜单 ----------
async function getMenuArr(env) {
  let list = await env.KV.get(MENU_KEY, "json");
  if (!Array.isArray(list) || list.length === 0) {
    list = DEFAULT_MENU.map((m, i) => ({ id: i + 1, emoji: m.emoji, name: m.name, tags: m.tags || [], weight: 2 }));
    await env.KV.put(MENU_KEY, JSON.stringify(list));
  }
  return list;
}
async function putMenu(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body)) return json({ error: "body must be array" }, 400);
  const items = body
    .slice(0, 60)
    .map((x, i) => ({
      id: i + 1,
      emoji: x.emoji || "🍽️",
      name: String(x.name || "").trim().slice(0, 40),
      tags: Array.isArray(x.tags) ? x.tags.slice(0, 8).map(String) : [],
      weight: Math.max(1, Math.min(20, parseInt(x.weight) || 2)),
    }))
    .filter((x) => x.name);
  if (items.length === 0) return json({ error: "empty menu" }, 400);
  await env.KV.put(MENU_KEY, JSON.stringify(items));
  return json({ ok: true, count: items.length });
}

// ---------- KV：当日记录 ----------
function luckLabel(n) {
  if (n <= 3) return "運勢不佳";
  if (n <= 7) return "運勢普通";
  return "鴻運當頭";
}
async function getRecordsArr(env, date) {
  const arr = await env.KV.get("records:" + date, "json");
  return Array.isArray(arr) ? arr : [];
}
async function tryRecord(env, rawName, rawRest, rawLuck) {
  const name = String(rawName || "").trim().slice(0, 40);
  const restaurant = String(rawRest || "").trim().slice(0, 60);
  if (!name || !restaurant) return { ok: false, error: "name and restaurant required" };
  let luck = parseInt(rawLuck);
  if (!Number.isInteger(luck) || luck < 1 || luck > 10) luck = null;
  const date = todayKey();
  const key = "records:" + date;
  const arr = await getRecordsArr(env, date);
  const ex = arr.find((r) => r.name === name);
  if (ex) return { ok: false, existing: ex.restaurant };
  arr.push({ name, restaurant, date, time: nowTime(), ts: Date.now(), ...(luck ? { luck, label: luckLabel(luck) } : {}) });
  await env.KV.put(key, JSON.stringify(arr), { expirationTtl: RECORD_TTL });
  return { ok: true, restaurant, luck };
}

// ---------- API ----------
async function getMenu(env) {
  const list = await getMenuArr(env);
  return json(list);
}
async function postDraw(request, env) {
  const b = await request.json().catch(() => ({}));
  const res = await tryRecord(env, b.name, b.restaurant, b.luck);
  if (!res.ok) {
    if (res.existing) return json({ error: "already_drawn_today", name: String(b.name || "").trim(), restaurant: res.existing }, 409);
    return json({ error: res.error }, 400);
  }
  return json({ ok: true, name: String(b.name || "").trim(), restaurant: res.restaurant, luck: res.luck, label: res.luck ? luckLabel(res.luck) : null });
}
async function getRecords(env, date) {
  const arr = await getRecordsArr(env, date);
  return json(arr);
}
async function clearRecords(env, date) {
  const d = date || todayKey();
  await env.KV.delete("records:" + d);
  return json({ ok: true, cleared: d });
}

function weightedPick(list) {
  const total = list.reduce((s, it) => s + it.weight, 0);
  let r = Math.random() * total;
  for (const it of list) { r -= it.weight; if (r <= 0) return it; }
  return list[list.length - 1];
}

// ---------- MCP Server (JSON-RPC over HTTP) ----------
async function handleMcp(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  const body = await request.json().catch(() => ({}));
  const id = body.id ?? null;
  const rpc = (result) => json({ jsonrpc: "2.0", id, result });
  const err = (code, message, status = 400) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);

  if (body.method === "initialize") {
    return json({ jsonrpc: "2.0", id, protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "lunch-app", version: VERSION } });
  }
  if (body.method === "tools/list") {
    return rpc({
      tools: [
        { name: "get_version", description: "查询当前部署的版本号与构建日期", inputSchema: { type: "object", properties: {} } },
        { name: "spin", description: "从共享菜单随机抽一家餐厅，并同时掷出今日运气值（D10，1-10 分 + 评语）。传入 name 会自动记录（餐厅+运气）并遵守「每人每天限抽一次」。", inputSchema: { type: "object", properties: { name: { type: "string", description: "抽奖人名字，可选；不传则只随机不记录" } } } },
        { name: "get_menu", description: "返回当前团队共享的餐厅菜单", inputSchema: { type: "object", properties: {} } },
        { name: "record_draw", description: "记录一次抽奖结果（name + restaurant + 可选 luck 1-10），每人每天限一次", inputSchema: { type: "object", properties: { name: { type: "string" }, restaurant: { type: "string" }, luck: { type: "integer", description: "运气分 1-10，可选" } }, required: ["name", "restaurant"] } },
        { name: "get_records", description: "返回某天（默认今天）的抽奖记录（KV 保存 30 天）", inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD，默认今天" } } } },
      ],
    });
  }
  if (body.method === "tools/call") {
    const tool = body.params?.name;
    const args = body.params?.arguments || {};
    let result;
    if (tool === "get_version") {
      result = { version: VERSION, build: BUILD_DATE, server: "lunch-app" };
    } else if (tool === "get_menu") {
      result = { menu: await getMenuArr(env) };
    } else if (tool === "spin") {
      const m = await getMenuArr(env);
      if (m.length === 0) result = { error: "菜单为空" };
      else {
        const pick = weightedPick(m);
        const luck = 1 + Math.floor(Math.random() * 10);
        if (args.name) {
          const rec = await tryRecord(env, args.name, pick.name, luck);
          result = { restaurant: pick.name, emoji: pick.emoji, luck, luck_label: luckLabel(luck), recorded: rec.ok, limited: !rec.ok, previous: rec.existing || null };
        } else {
          result = { restaurant: pick.name, emoji: pick.emoji, luck, luck_label: luckLabel(luck), recorded: false };
        }
      }
    } else if (tool === "record_draw") {
      const rec = await tryRecord(env, args.name, args.restaurant, args.luck);
      result = rec.ok ? { ok: true, restaurant: rec.restaurant, luck: rec.luck, label: rec.luck ? luckLabel(rec.luck) : null } : { error: "already_drawn_today", previous: rec.existing };
    } else if (tool === "get_records") {
      const d = args.date || todayKey();
      result = { date: d, records: await getRecordsArr(env, d) };
    } else {
      return err(-32601, "unknown tool", 404);
    }
    return rpc({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  }
  return err(-32600, "unsupported method");
}

// ---------- 路由 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    if (p === "/api/version") return json({ version: VERSION, build: BUILD_DATE, name: "lunch-app", storage: "kv" });
    if (p === "/api/menu") {
      if (request.method === "GET") return await getMenu(env);
      if (request.method === "PUT") return await putMenu(request, env);
      return json({ error: "method not allowed" }, 405);
    }
    if (p === "/api/draw" && request.method === "POST") return await postDraw(request, env);
    if (p === "/api/records") {
      if (request.method === "GET") return await getRecords(env, url.searchParams.get("date") || todayKey());
      if (request.method === "DELETE") return await clearRecords(env, url.searchParams.get("date"));
      return json({ error: "method not allowed" }, 405);
    }
    if (p === "/mcp") return await handleMcp(request, env);

    // 其余交给前端静态资源
    return env.ASSETS.fetch(request);
  },
};
