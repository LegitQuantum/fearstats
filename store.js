"use strict";

// Хранилище: отслеживаемые модераторы (data/mods.json) и нормы рангов (data/ranks.json).
// Модератор: { steamid, name, rank }  — rank: 1=мл.Модер, 2=Модератор, 3=ст.Модератор, 4=ст.Админ
// Эффективная норма модератора = норма его ранга (rankNorm).

const fs = require("fs");
const path = require("path");
const SEED = require("./moderators");

const DATA_DIR = path.join(__dirname, "data");
const MODS_FILE = path.join(DATA_DIR, "mods.json");
const RANKS_FILE = path.join(DATA_DIR, "ranks.json");

// Нормы рангов по умолчанию (только наказания, тикеты не учитываются)
const DEFAULT_RANKS = [
  { rank: 1, title: "Мл. Модератор", week: 20, month: 100 },
  { rank: 2, title: "Модератор", week: 30, month: 130 },
  { rank: 3, title: "Ст. Модератор", week: 0, month: 70 },
  { rank: 4, title: "Ст. Администратор", week: 0, month: 50 },
  { rank: 5, title: "Стафф", week: 0, month: 0 } // без нормы
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------- Ранги ----------

function loadRanks() {
  const data = readJson(RANKS_FILE);
  if (data && Array.isArray(data.ranks) && data.ranks.length) return data.ranks;
  writeJson(RANKS_FILE, { ranks: DEFAULT_RANKS });
  return DEFAULT_RANKS.map((r) => ({ ...r }));
}

// Задать норму ранга. week или month = 0 — нормы нет (хотя бы одна должна быть > 0).
function setRankNorm(rank, week, month) {
  const ranks = loadRanks();
  const r = ranks.find((x) => x.rank === rank);
  if (!r) return null;
  r.week = week;
  r.month = month;
  writeJson(RANKS_FILE, { ranks });
  return r;
}

// Эффективная норма по номеру ранга (null — если ранга нет)
function rankNorm(rank) {
  const r = loadRanks().find((x) => x.rank === rank);
  if (!r || (r.week <= 0 && r.month <= 0)) return null;
  return { week: r.week, month: r.month };
}

function rankTitle(rank) {
  const r = loadRanks().find((x) => x.rank === rank);
  return r ? r.title : null;
}

// ---------- Модераторы ----------

function load() {
  const data = readJson(MODS_FILE);
  let mods = data && Array.isArray(data.moderators) ? data.moderators : null;
  if (!mods) {
    // первый запуск: наполняем из исходного списка, всем ранг 1
    mods = SEED.map(([name, steamid]) => ({ steamid, name, rank: 1 }));
    writeJson(MODS_FILE, { moderators: mods });
    return mods;
  }
  // миграция старого формата: norma -> rank
  let changed = false;
  for (const m of mods) {
    if ("norma" in m) {
      m.rank = m.norma && m.norma.week === 20 && m.norma.month === 100 ? 1 : (m.rank ?? 1);
      delete m.norma;
      changed = true;
    }
    if (!("rank" in m)) {
      m.rank = 1;
      changed = true;
    }
  }
  if (changed) writeJson(MODS_FILE, { moderators: mods });
  return mods;
}

function add(steamid, name, rank = 1) {
  const mods = load();
  if (mods.some((m) => m.steamid === steamid)) return null;
  const mod = { steamid, name: name || steamid, rank };
  mods.push(mod);
  writeJson(MODS_FILE, { moderators: mods });
  return mod;
}

function remove(steamid) {
  const mods = load();
  const i = mods.findIndex((m) => m.steamid === steamid);
  if (i === -1) return false;
  mods.splice(i, 1);
  writeJson(MODS_FILE, { moderators: mods });
  return true;
}

// Назначить ранг модератору (true — найден)
function setRank(steamid, rank) {
  const mods = load();
  const mod = mods.find((m) => m.steamid === steamid);
  if (!mod) return false;
  mod.rank = rank;
  writeJson(MODS_FILE, { moderators: mods });
  return true;
}

// Привязать Discord-ник модератору (true — найден)
function setDiscord(steamid, discord) {
  const cleaned = String(discord || "").replace(/^@/, "").trim();
  if (!cleaned) return false;
  const mods = load();
  const mod = mods.find((m) => m.steamid === steamid);
  if (!mod) return false;
  mod.discord = cleaned;
  writeJson(MODS_FILE, { moderators: mods });
  return true;
}

// Задать отображаемое имя модератора (true — найден)
function setName(steamid, name) {
  const cleaned = String(name || "")
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;
  const mods = load();
  const mod = mods.find((m) => m.steamid === steamid);
  if (!mod) return false;
  mod.name = cleaned;
  writeJson(MODS_FILE, { moderators: mods });
  return true;
}

module.exports = { load, add, remove, setRank, setName, setDiscord, loadRanks, setRankNorm, rankNorm, rankTitle, DEFAULT_RANKS };
