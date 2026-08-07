"use strict";

const fs = require("fs");
const path = require("path");
const store = require("./store");

const API_URL = "https://fearproject.ru/api/punishments";
const MSK_OFFSET_SEC = 3 * 3600; // Москва: UTC+3, без перехода на летнее время
const PAGE_SIZE = 20; // API отдаёт максимум 20 записей на страницу
const MAX_PAGES = 1500; // защитный лимит (1500 * 20 = 30 000 записей на тип)
const PAGE_DELAY_MS = 180;

const CACHE_FILE = path.join(__dirname, "data", "cache.json");

// type=1 — баны, type=2 — муты (по API сайта)
const KIND_BY_TYPE = { 1: "ban", 2: "mute" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Границы текущего месяца по Москве, в секундах (unix)
function currentMonthRange(now = new Date()) {
  const msk = new Date(now.getTime() + MSK_OFFSET_SEC * 1000);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth();
  const start = Date.UTC(y, m, 1) / 1000 - MSK_OFFSET_SEC;
  const end = Date.UTC(y, m + 1, 1) / 1000 - MSK_OFFSET_SEC;
  return { start, end };
}

// Начало текущей недели (понедельник 00:00 МСК), в секундах (unix)
function currentWeekStart(now = new Date()) {
  const msk = new Date(now.getTime() + MSK_OFFSET_SEC * 1000);
  const day = (msk.getUTCDay() + 6) % 7; // 0 = понедельник
  return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - day) / 1000 - MSK_OFFSET_SEC;
}

function monthLabel(now = new Date()) {
  const s = now.toLocaleString("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow"
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function fetchPage(type, page) {
  const url = `${API_URL}?page=${page}&limit=${PAGE_SIZE}&type=${type}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "ModStatsFear/1.0 (local stats)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  const json = await res.json();
  return Array.isArray(json.punishments) ? json.punishments : [];
}

// Тянет страницы от новых к старым, пока не упрётся в sinceSec.
// Возвращает все наказания данного типа начиная с sinceSec.
async function fetchTypeSince(type, sinceSec) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    let items;
    for (let attempt = 1; ; attempt++) {
      try {
        items = await fetchPage(type, page);
        break;
      } catch (e) {
        const is429 = e && e.message && e.message.includes("429");
        const maxAttempts = is429 ? 6 : 4;
        if (attempt >= maxAttempts) throw e;
        // при рейт-лимите ждём дольше: 15с, 30с, 45с, 60с, 75с; иначе 3с, 6с, 9с
        await sleep(is429 ? attempt * 15000 : attempt * 3000);
      }
    }
    if (items.length === 0) break;

    let oldest = Infinity;
    for (const p of items) {
      if (seen.has(p.id)) continue; // защита от дублей при сдвиге пагинации
      seen.add(p.id);
      if (p.created < oldest) oldest = p.created;
      if (p.created >= sinceSec) out.push(p);
    }
    if (oldest < sinceSec) break; // дальше только старые записи
    await sleep(PAGE_DELAY_MS);
  }
  return out;
}

function formatDuration(p) {
  if (p.expires === 0) return "Навсегда";
  const d = Math.max(0, p.expires - p.created);
  const days = Math.floor(d / 86400);
  const hours = Math.floor((d % 86400) / 3600);
  const mins = Math.round((d % 3600) / 60);
  if (days > 0) return `${days} дн.`;
  if (hours > 0) return mins > 0 ? `${hours} ч. ${mins} мин.` : `${hours} ч.`;
  return `${mins} мин.`;
}

// Причины-исключения: процедурные баны ("напиши тикет", "обратись в поддержку"
// и подобные) в статистику не входят. Регистр не важен.
const EXCLUDED_REASONS = [/тикет/i, /обрат\w*\s+в\s+поддержк/i];

function isExcludedReason(reason) {
  const s = String(reason || "");
  return EXCLUDED_REASONS.some((re) => re.test(s));
}

// Наказание НЕ засчитывается, если снято вручную (unpunish_admin / status=2)
// или причина в списке исключений.
// Истёкшие (status=4) и активные (status=1) — засчитываются.
function isCounted(p) {
  return !p.unpunish_admin && p.status !== 2 && !isExcludedReason(p.reason);
}

function normalize(p, kind) {
  return {
    id: p.id,
    kind, // 'ban' | 'mute'
    player: p.name,
    playerSteamid: p.steamid,
    reason: p.reason,
    created: p.created,
    expires: p.expires,
    durationLabel: formatDuration(p),
    status: p.status, // 1=активен, 2=снят вручную, 4=истёк
    counted: isCounted(p),
    excluded: !p.unpunish_admin && p.status !== 2 && isExcludedReason(p.reason), // исключён по причине
    unpunishAdmin: p.unpunish_admin || null
  };
}

async function buildStats() {
  const { start: monthStart, end: monthEnd } = currentMonthRange();
  const weekStart = currentWeekStart();
  const scanSince = Math.min(monthStart, weekStart); // неделя может начаться в прошлом месяце

  const ranks = store.loadRanks();
  const normByRank = new Map(ranks.map((r) => [r.rank, { week: r.week, month: r.month }]));

  const mods = store.load().map((m) => ({
    name: m.name,
    steamid: m.steamid,
    rank: m.rank ?? null,
    norma: ((n) => (n && (n.week > 0 || n.month > 0) ? n : null))(normByRank.get(m.rank)),
    lastSeenName: null,
    bans: 0,
    mutes: 0,
    total: 0,
    weekTotal: 0, // засчитанные наказания с понедельника (МСК)
    removed: 0, // снято вручную
    excluded: 0, // исключено по причине (тикет/поддержка)
    records: [] // только записи текущего месяца
  }));
  const bySteamid = new Map(mods.map((m) => [m.steamid, m]));

  for (const type of [1, 2]) {
    const kind = KIND_BY_TYPE[type];
    const items = await fetchTypeSince(type, scanSince);
    for (const p of items) {
      const mod = bySteamid.get(p.admin_steamid);
      if (!mod) continue; // наказания не отслеживаемых админов пропускаем
      const counted = isCounted(p);
      if (p.created >= weekStart && counted) mod.weekTotal++;
      if (p.created >= monthStart && p.created < monthEnd) {
        const rec = normalize(p, kind);
        mod.records.push(rec);
        mod.lastSeenName = p.admin;
        if (counted) {
          if (kind === "ban") mod.bans++;
          else mod.mutes++;
          mod.total++;
        } else if (rec.excluded) {
          mod.excluded++;
        } else {
          mod.removed++;
        }
      }
    }
    await sleep(PAGE_DELAY_MS);
  }

  for (const mod of mods) {
    mod.records.sort((a, b) => b.created - a.created);
    // если имя не задано вручную, показываем ник с сайта (очищенный от невидимых символов)
    if (mod.name === mod.steamid && mod.lastSeenName) {
      const cleaned = String(mod.lastSeenName)
        .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      mod.name = cleaned || mod.steamid;
    }
  }
  mods.sort((a, b) => b.total - a.total || b.bans - a.bans || a.name.localeCompare(b.name, "ru"));

  const totals = {
    bans: mods.reduce((s, m) => s + m.bans, 0),
    mutes: mods.reduce((s, m) => s + m.mutes, 0),
    total: mods.reduce((s, m) => s + m.total, 0),
    removed: mods.reduce((s, m) => s + m.removed, 0),
    excluded: mods.reduce((s, m) => s + m.excluded, 0)
  };

  return {
    updatedAt: Math.floor(Date.now() / 1000),
    month: monthLabel(),
    monthStart,
    monthEnd,
    weekStart,
    totals,
    moderators: mods
  };
}

function saveCache(data) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = CACHE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, CACHE_FILE);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Несколько полных пересчётов с объединением результатов:
// записи всех проходов объединяются по id (страховка от сдвига пагинации
// во время сканирования), счётчики пересчитываются по объединённому набору.
async function buildStatsThorough(passes = 5) {
  const snapshots = [];
  for (let i = 0; i < passes; i++) {
    snapshots.push(await buildStats());
    if (i < passes - 1) await sleep(1000);
  }
  const last = snapshots[snapshots.length - 1];

  for (const mod of last.moderators) {
    const union = new Map();
    for (const snap of snapshots) {
      const sm = snap.moderators.find((x) => x.steamid === mod.steamid);
      if (!sm) continue;
      for (const r of sm.records) {
        const key = `${r.kind}:${r.id}`;
        if (!union.has(key)) union.set(key, r);
      }
    }
    mod.records = [...union.values()].sort((a, b) => b.created - a.created);
    mod.bans = mod.records.filter((r) => r.counted && r.kind === "ban").length;
    mod.mutes = mod.records.filter((r) => r.counted && r.kind === "mute").length;
    mod.total = mod.bans + mod.mutes;
    mod.removed = mod.records.filter((r) => !r.counted && !r.excluded).length;
    mod.excluded = mod.records.filter((r) => r.excluded).length;
    const inWeek = mod.records.filter((r) => r.counted && r.created >= last.weekStart).length;
    const maxPass = Math.max(
      ...snapshots.map((s) => {
        const sm = s.moderators.find((x) => x.steamid === mod.steamid);
        return sm ? sm.weekTotal : 0;
      })
    );
    mod.weekTotal = Math.max(inWeek, maxPass);
  }
  last.moderators.sort((a, b) => b.total - a.total || b.bans - a.bans || a.name.localeCompare(b.name, "ru"));
  last.totals = {
    bans: last.moderators.reduce((s, m) => s + m.bans, 0),
    mutes: last.moderators.reduce((s, m) => s + m.mutes, 0),
    total: last.moderators.reduce((s, m) => s + m.total, 0),
    removed: last.moderators.reduce((s, m) => s + m.removed, 0),
    excluded: last.moderators.reduce((s, m) => s + (m.excluded || 0), 0)
  };
  last.updatedAt = Math.floor(Date.now() / 1000);
  return last;
}

// Обёртка над buildStats: если кэш свежий (его только что обновил
// другой процесс — сайт или бот), повторный скан не нужен.
async function refreshStats(freshSec = 120) {
  const cached = loadCache();
  if (
    cached &&
    cached.weekStart && // кэш нового формата
    cached.updatedAt &&
    Date.now() / 1000 - cached.updatedAt < freshSec
  ) {
    return cached;
  }
  const data = await buildStats();
  saveCache(data);
  return data;
}

// Анализ config.vdf: извлекает аккаунты (имя + SteamID) и проверяет каждый
// SteamID на активные баны fearproject.ru.
// Возвращает готовый текст отчёта.
async function analyzeVdf(text) {
  const accounts = [];
  const seen = new Set();
  const re = /"([^"\n]+)"\s*\{[\s\S]{0,200}?"SteamID"\s*"(\d{17})"[\s\S]{0,200}?\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    accounts.push({ name: m[1], steamid: m[2] });
  }
  if (!accounts.length) {
    return '⚠️ В файле не найдено ни одного SteamID. Убедитесь, что это config.vdf с разделом "Accounts".';
  }

  const banned = [];
  for (const acc of accounts) {
    try {
      const r = await fetch(`${API_URL}/search?q=${acc.steamid}&page=1&limit=20&type=1`, {
        headers: { "User-Agent": "ModStatsFear/1.0 (vdf check)" }
      });
      const j = await r.json();
      for (const p of j.punishments || []) {
        if (p.steamid === acc.steamid && p.status === 1) banned.push({ acc, p }); // только активные баны
      }
    } catch { /* сбойный аккаунт пропускаем */ }
    await sleep(250);
  }

  const fmtD = (ts) =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(ts * 1000));

  let out = `📄 **Анализ config.vdf** — аккаунтов: ${accounts.length}\n`;
  if (!banned.length) {
    out += "\n✅ **банов не обнаружено**";
  } else {
    out += `\n🚫 **Найдено банов: ${banned.length}**\n`;
    for (const { acc, p } of banned) {
      out +=
        `\n• Аккаунт: **${acc.name}**\n` +
        `  Ник: **${p.name}** (\`${acc.steamid}\`)\n` +
        `  Причина: ${p.reason}\n` +
        `  Срок: ${formatDuration(p)}\n` +
        `  Выдан: ${fmtD(p.created)} МСК\n` +
        `  Окончание: ${p.expires === 0 ? "Навсегда" : fmtD(p.expires) + " МСК"}\n`;
    }
  }
  return out.length > 1900 ? out.slice(0, 1900) + "\n…" : out;
}

// Поиск подозрительных новичков: playtime < maxPlaytime и K/D > minKd.
// Сканирует топ страницы (быстрый подъём = очень подозрительно)
// и хвост лидерборда (свежие аккаунты).
async function fetchLeaderboardPage(page) {
  const url = `${API_URL.replace("/punishments", "/leaderboard")}?page=${page}&limit=20`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "ModStatsFear/1.0 (suspect watch)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      const is429 = e && e.message && e.message.includes("429");
      if (attempt >= (is429 ? 6 : 4)) throw e;
      await sleep(is429 ? attempt * 15000 : attempt * 3000);
    }
  }
}

async function findSuspects({ topPages = 10, tailPages = 150, maxPlaytime = 7200, minKd = 2 } = {}) {
  const suspects = [];
  const seen = new Set();
  const consider = (p) => {
    if (seen.has(p.steamid)) return;
    seen.add(p.steamid);
    const kd = p.kills / Math.max(1, p.deaths);
    if (p.playtime < maxPlaytime && kd > minKd) {
      suspects.push({
        steamid: p.steamid,
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        kd: Math.round(kd * 100) / 100,
        playtime: p.playtime,
        value: p.value,
        position: p.position
      });
    }
  };

  const first = await fetchLeaderboardPage(1);
  for (const p of first.players || []) consider(p);
  const lastPage = Math.max(1, Math.ceil((first.total || 0) / 20));

  for (let page = 2; page <= topPages && page <= lastPage; page++) {
    const j = await fetchLeaderboardPage(page);
    for (const p of j.players || []) consider(p);
    await sleep(180);
  }
  for (let page = lastPage; page > lastPage - tailPages && page > topPages; page--) {
    const j = await fetchLeaderboardPage(page);
    for (const p of j.players || []) consider(p);
    await sleep(180);
  }
  return suspects;
}

module.exports = { buildStats, buildStatsThorough, refreshStats, saveCache, loadCache, currentMonthRange, currentWeekStart, analyzeVdf, formatDuration, findSuspects };
