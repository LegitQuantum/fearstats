"use strict";

// Формирование Discord-эмбеда со статистикой модераторов
// и текста норм (отправляется вне эмбеда).
const { EmbedBuilder } = require("discord.js");

const fmtTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

// Невидимые/форматирующие символы (zero-width, variation selectors и т.п.)
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g;

function cleanName(s) {
  return String(s == null ? "" : s).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

const fmtDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric"
});

// Процент выполнения нормы: по месячной норме, если она задана, иначе по недельной.
function completion(m) {
  if (!m.norma) return null;
  const total = m.total || 0;
  const weekTotal = m.weekTotal || 0;
  if (m.norma.month > 0) {
    return { pct: Math.round((total / m.norma.month) * 100), done: total >= m.norma.month };
  }
  if (m.norma.week > 0) {
    return { pct: Math.round((weekTotal / m.norma.week) * 100), done: weekTotal >= m.norma.week };
  }
  return null;
}

// Короткие подписи должностей для столбца "Должность"
const RANK_SHORT = { 1: "мл. мод", 2: "мод", 3: "ст. мод", 4: "админ", 5: "стафф" };

const MEDALS = ["🥇", "🥈", "🥉"];

function buildEmbed(s) {
  const lines = s.moderators.map((m, i) => {
    const name = cleanName(m.name) || m.steamid;
    const medal = MEDALS[i] ? MEDALS[i] + " " : "";
    const rank = RANK_SHORT[m.rank] ? ` (${RANK_SHORT[m.rank]})` : "";
    const c = completion(m);
    const comp = c ? ` • ${c.pct}%${c.done ? "✓" : ""}` : "";
    return `${medal}${i + 1}. **${name}**${rank}: 🔨 ${m.bans} 🔓 ${m.removed} 🔕 ${m.mutes} = **${m.total}**${comp}`;
  });

  const description =
    "👥 **Модераторы**\n" +
    lines.join("\n") +
    "\n\n📊 **Итого**\n" +
    `🔨 Баны: **${s.totals.bans}**\n` +
    `🟧 Разбаны: **${s.totals.removed}**\n` +
    `🔕 Муты: **${s.totals.mutes}**\n` +
    `📌 Всего: **${s.totals.total}**\n` +
    (s.totals.excluded ? `🚫 Исключено (тикет/поддержка): **${s.totals.excluded}**\n` : "") +
    "\nСтатистика была взята с официального сайта FearProject.ru.";

  return new EmbedBuilder()
    .setColor(0x4d70ef)
    .setTitle(`📊 Статистика за ${fmtDate.format(new Date(s.updatedAt * 1000))}`)
    .setDescription(description)
    .setFooter({
      text: `Обновлено ${fmtTime.format(new Date(s.updatedAt * 1000))} МСК`
    });
}

// Текст норм вне эмбеда — публичный список норм по рангам
// (как на скрине; только наказания, тикеты не учитываются).
const { loadRanks } = require("./store");

function buildNormsText() {
  const parts = [];
  for (const r of loadRanks()) {
    const lines = [`**${r.title}**`];
    if (r.week > 0) lines.push(`• еженедельная норма — ${r.week}`);
    if (r.month > 0) lines.push(`• ежемесячная норма — ${r.month}`);
    if (r.week <= 0 && r.month <= 0) lines.push("• без нормы");
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

module.exports = { buildEmbed, buildNormsText, fmtTime, completion };
