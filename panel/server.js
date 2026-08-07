"use strict";

// Веб-панель управления ботом (HTTP + Discord OAuth2).
// Роли: владелец (panelOwner) — полный доступ; остальные — статистика + «Озвучить».

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const SESSION_TTL = 30 * 86400 * 1000;

let ctx = null; // { client, config, store, loadCache, loadState, saveState, speakInConnection, findVoiceConnection }
const sessions = new Map(); // token -> { id, username, avatar, owner, expires }
const oauthStates = new Set();
let guildCache = { guild: null, at: 0 };

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Некорректный JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getSession(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)panel_sid=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) {
    sessions.delete(m[1]);
    return null;
  }
  return s;
}

function isOwner(sess) {
  return sess && sess.id === String(ctx.config.panelOwner || "");
}

function redirect(res, location, extra) {
  res.writeHead(302, { Location: location, ...(extra || {}) });
  res.end();
}

/* ---------- OAuth2 ---------- */

function oauthClientId() {
  const cfg = ctx.config;
  return cfg.discordClientId || Buffer.from(String(cfg.discordToken || "").split(".")[0] || "", "base64").toString();
}

function handleLogin(req, res) {
  const cfg = ctx.config;
  if (!cfg.discordClientSecret) return sendJson(res, 500, { error: "Не настроен discordClientSecret" });
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.add(state);
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);
  redirect(
    res,
    "https://discord.com/oauth2/authorize?response_type=code" +
      `&client_id=${encodeURIComponent(oauthClientId())}` +
      `&redirect_uri=${encodeURIComponent(cfg.oauthRedirectUri)}` +
      "&scope=identify" +
      `&state=${state}` +
      "&prompt=none"
  );
}

async function handleCallback(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state || !oauthStates.has(state)) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    return res.end("Неверный state. <a href='/auth/login'>Войти</a> ещё раз.");
  }
  oauthStates.delete(state);
  const cfg = ctx.config;
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClientId(),
        client_secret: cfg.discordClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.oauthRedirectUri
      })
    });
    if (!tokenRes.ok) throw new Error("token exchange HTTP " + tokenRes.status);
    const tokens = await tokenRes.json();
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!userRes.ok) throw new Error("users/@me HTTP " + userRes.status);
    const user = await userRes.json();
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      expires: Date.now() + SESSION_TTL
    });
    console.log(`[panel] вход: ${user.username} (${user.id})${isOwner({ id: user.id }) ? " [владелец]" : ""}`);
    redirect(res, "/", { "Set-Cookie": `panel_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}` });
  } catch (e) {
    console.error("[panel] ошибка входа:", e && e.message ? e.message : e);
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end("Ошибка входа. <a href='/auth/login'>Ещё раз</a>.");
  }
}

function handleLogout(req, res) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)panel_sid=([a-f0-9]{64})/);
  if (m) sessions.delete(m[1]);
  redirect(res, "/auth/login", { "Set-Cookie": "panel_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
}

/* ---------- Guild ---------- */

async function getGuild() {
  if (guildCache.guild && Date.now() - guildCache.at < 60000) return guildCache.guild;
  const ch = await ctx.client.channels.fetch(ctx.config.channelId);
  guildCache = { guild: ch.guild, at: Date.now() };
  return ch.guild;
}

function botMember(guild) {
  return guild.members.me;
}

function canAct(guild, member) {
  const me = botMember(guild);
  return member && me && member.roles.highest.position < me.roles.highest.position;
}

/* ---------- API ---------- */

async function handleApi(req, res, sess, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const owner = isOwner(sess);

  // --- публичные (любой вошедший) ---
  if (p === "/api/me") {
    return sendJson(res, 200, { id: sess.id, username: sess.username, avatar: sess.avatar, owner });
  }
  if (p === "/api/stats" && req.method === "GET") {
    return sendJson(res, 200, ctx.loadCache());
  }
  if (p === "/api/saylog" && req.method === "GET") {
    const state = ctx.loadState();
    return sendJson(res, 200, { list: state.sayLog || [] });
  }
  if (p === "/api/say" && req.method === "POST") {
    const body = await readBody(req);
    let text = String(body.text || "").trim().slice(0, 190);
    if (!text) return sendJson(res, 400, { error: "Пустой текст" });
    const conn = ctx.findVoiceConnection();
    if (!conn) return sendJson(res, 409, { error: "Бот не находится в голосовом канале" });
    await ctx.speakInConnection(conn, text);
    const state = ctx.loadState();
    state.sayLog = [{ userId: sess.id, username: sess.username, text, ts: Date.now() }, ...(state.sayLog || [])].slice(0, 10);
    ctx.saveState(state);
    console.log(`[panel] say: ${sess.username}: "${text.slice(0, 60)}"`);
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/voicestatus" && req.method === "GET") {
    const conn = ctx.findVoiceConnection();
    let channel = null;
    if (conn) {
      try {
        const ch = await ctx.client.channels.fetch(conn.joinConfig.channelId);
        channel = { name: ch && ch.name, guild: ch && ch.guild && ch.guild.name };
      } catch { /* игнор */ }
    }
    return sendJson(res, 200, { connected: !!conn, channel });
  }

  // --- дальше только владелец ---
  if (!owner) return sendJson(res, 403, { error: "Нет доступа" });

  if (p === "/api/mods" && req.method === "GET") {
    return sendJson(res, 200, { moderators: ctx.store.load(), ranks: ctx.store.loadRanks() });
  }
  if (p === "/api/mods" && req.method === "POST") {
    const body = await readBody(req);
    const steamid = String(body.steamid || "").trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { error: "SteamID64 должен быть 17 цифр" });
    const mod = ctx.store.add(steamid, String(body.name || "").trim() || steamid, 1);
    if (!mod) return sendJson(res, 409, { error: "Такой SteamID уже есть" });
    return sendJson(res, 200, { ok: true, mod });
  }
  if (p === "/api/mods" && req.method === "PATCH") {
    const body = await readBody(req);
    const steamid = String(body.steamid || "").trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { error: "SteamID64 должен быть 17 цифр" });
    if (!ctx.store.load().some((m) => m.steamid === steamid)) return sendJson(res, 404, { error: "Не найден" });
    if (body.name !== undefined && !ctx.store.setName(steamid, body.name)) return sendJson(res, 400, { error: "Имя не может быть пустым" });
    if (body.rank !== undefined) {
      const rank = Number(body.rank);
      if (!Number.isInteger(rank) || rank < 1 || rank > 5) return sendJson(res, 400, { error: "Ранг 1-5" });
      ctx.store.setRank(steamid, rank);
    }
    if (body.discord !== undefined) {
      const d = String(body.discord).trim();
      if (d) ctx.store.setDiscord(steamid, d);
      else ctx.store.clearDiscord(steamid);
    }
    return sendJson(res, 200, { ok: true, mod: ctx.store.load().find((m) => m.steamid === steamid) });
  }
  if (p === "/api/mods" && req.method === "DELETE") {
    const body = await readBody(req);
    const steamid = String(body.steamid || "").trim();
    if (!ctx.store.remove(steamid)) return sendJson(res, 404, { error: "Не найден" });
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/ranks" && req.method === "POST") {
    const body = await readBody(req);
    const rank = Number(body.rank);
    const week = Math.max(0, Number(body.week) || 0);
    const month = Math.max(0, Number(body.month) || 0);
    if (!Number.isInteger(rank) || rank < 1 || rank > 5) return sendJson(res, 400, { error: "Ранг 1-5" });
    const r = ctx.store.setRankNorm(rank, week, month);
    if (!r) return sendJson(res, 404, { error: "Ранг не найден" });
    return sendJson(res, 200, { ok: true, rank: r });
  }

  // --- модерация ---
  if (p === "/api/guild" && req.method === "GET") {
    const guild = await getGuild();
    const me = botMember(guild);
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed && me && r.position < me.roles.highest.position)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
    return sendJson(res, 200, { id: guild.id, name: guild.name, roles });
  }
  if (p === "/api/members" && req.method === "GET") {
    const guild = await getGuild();
    const query = String(q.get("q") || "").toLowerCase().trim();
    const members = await guild.members.fetch({ limit: 1000 });
    let list = [...members.values()];
    if (query) {
      list = list.filter(
        (m) =>
          m.user.username.toLowerCase().includes(query) ||
          (m.nickname || "").toLowerCase().includes(query) ||
          m.id === query
      );
    }
    list = list.slice(0, 100).map((m) => ({
      id: m.id,
      username: m.user.username,
      nickname: m.nickname,
      avatar: m.user.displayAvatarURL({ size: 32 }),
      timedOut: !!m.communicationDisabledUntilTimestamp,
      canAct: canAct(guild, m),
      roles: m.roles.cache.map((r) => r.id)
    }));
    return sendJson(res, 200, { members: list, total: members.size });
  }
  if (p === "/api/member-action" && req.method === "POST") {
    const body = await readBody(req);
    const guild = await getGuild();
    const id = String(body.userId || "");
    const reason = String(body.reason || "").trim() || `панель (${sess.username})`;
    try {
      switch (body.action) {
        case "timeout": {
          const m = await guild.members.fetch(id);
          if (!canAct(guild, m)) return sendJson(res, 400, { error: "Его роль не ниже роли бота" });
          const ms = Math.min(Math.max(0, Number(body.ms) || 600000), 28 * 86400 * 1000);
          await m.timeout(ms, reason);
          return sendJson(res, 200, { ok: true, message: `Таймаут на ${Math.round(ms / 60000)} мин выдан <@${id}>` });
        }
        case "untimeout": {
          const m = await guild.members.fetch(id);
          await m.timeout(null, reason);
          return sendJson(res, 200, { ok: true, message: `Таймаут снят с <@${id}>` });
        }
        case "kick": {
          const m = await guild.members.fetch(id);
          if (!canAct(guild, m)) return sendJson(res, 400, { error: "Его роль не ниже роли бота" });
          await m.kick(reason);
          return sendJson(res, 200, { ok: true, message: `<@${id}> кикнут` });
        }
        case "ban": {
          const m = await guild.members.fetch(id).catch(() => null);
          if (m && !canAct(guild, m)) return sendJson(res, 400, { error: "Его роль не ниже роли бота" });
          await guild.members.ban(id, { reason });
          return sendJson(res, 200, { ok: true, message: `<@${id}> забанен` });
        }
        case "unban": {
          await guild.members.unban(id, reason);
          return sendJson(res, 200, { ok: true, message: `ID ${id} разбанен` });
        }
        case "nick": {
          const m = await guild.members.fetch(id);
          if (!canAct(guild, m)) return sendJson(res, 400, { error: "Его роль не ниже роли бота" });
          const nick = String(body.value || "").trim() || null;
          await m.setNickname(nick, reason);
          return sendJson(res, 200, { ok: true, message: nick ? `Ник <@${id}> → ${nick}` : `Ник <@${id}> сброшен` });
        }
        case "addrole":
        case "removerole": {
          const roleId = String(body.roleId || "");
          const role = await guild.roles.fetch(roleId).catch(() => null);
          if (!role) return sendJson(res, 404, { error: "Роль не найдена" });
          const me = botMember(guild);
          if (me && role.position >= me.roles.highest.position) return sendJson(res, 400, { error: "Роль выше роли бота" });
          const m = await guild.members.fetch(id);
          if (body.action === "addrole") {
            await m.roles.add(role, reason);
            return sendJson(res, 200, { ok: true, message: `Роль **${role.name}** выдана <@${id}>` });
          }
          await m.roles.remove(role, reason);
          return sendJson(res, 200, { ok: true, message: `Роль **${role.name}** снята с <@${id}>` });
        }
        default:
          return sendJson(res, 400, { error: "Неизвестное действие" });
      }
    } catch (e) {
      return sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  }

  return sendJson(res, 404, { error: "not found" });
}

/* ---------- Static ---------- */

function serveStatic(req, res, urlPath) {
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------- Start ---------- */

function start(context) {
  ctx = context;
  const port = Number(ctx.config.panelPort) || 3000;
  const host = String(ctx.config.panelHost || "0.0.0.0");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;

      if (p === "/auth/login") return handleLogin(req, res);
      if (p === "/auth/callback") return await handleCallback(req, res);
      if (p === "/auth/logout") return handleLogout(req, res);

      const sess = getSession(req);
      if (!sess) {
        if (p.startsWith("/api/")) return sendJson(res, 401, { error: "Требуется вход через Discord" });
        return redirect(res, "/auth/login");
      }
      if (p.startsWith("/api/")) return await handleApi(req, res, sess, url);
      if (req.method === "GET") return serveStatic(req, res, p);
      res.writeHead(405);
      res.end("Method not allowed");
    } catch (e) {
      sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  });

  server.listen(port, host, () => {
    console.log(`[panel] веб-панель: http://${host}:${port}`);
  });
  return server;
}

module.exports = { start };
