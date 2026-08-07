"use strict";

// Команды модерации (c.<команда>) — перенос функционала Akemi.
// Права — по правам Discord (не по списку владельцев бота).

const fs = require("fs");
const path = require("path");
const { EmbedBuilder, AuditLogEvent, PermissionsBitField } = require("discord.js");

const INF_FILE = path.join(__dirname, "data", "infractions.json");
const TR_FILE = path.join(__dirname, "data", "temproles.json");

// Стафф-роли модерации от высшей к низшей (config.json -> modRanks)
const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  } catch {
    return {};
  }
})();
const STAFF_RANKS = Array.isArray(CONFIG.modRanks) ? CONFIG.modRanks.map(String) : [];

// Индекс стафф-роли участника (0 — высшая), -1 — нет стафф-роли
function staffRank(member) {
  if (!member) return -1;
  for (let i = 0; i < STAFF_RANKS.length; i++) {
    if (member.roles.cache.has(STAFF_RANKS[i])) return i;
  }
  return -1;
}

// Наказать можно только нижестоящего: у цели ранг строго НИЖЕ (больше индекс), чем у автора
function targetRankOk(message, member) {
  if (!member) return true;
  const tRank = staffRank(member);
  if (tRank === -1) return true; // у цели нет стафф-роли — можно
  return tRank > staffRank(message.member);
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/* ---------- хелперы ---------- */

function parseId(token) {
  const m = String(token || "").match(/(\d{17,20})/);
  return m ? m[1] : null;
}

// "10m", "2h", "1d", "30s" (+ русские с/м/ч/д) -> мс
function parseTime(token) {
  const m = String(token || "").toLowerCase().match(/^(\d+)\s*(s|с|m|м|h|ч|d|д)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "s" || unit === "с") return n * 1000;
  if (unit === "m" || unit === "м") return n * 60 * 1000;
  if (unit === "h" || unit === "ч") return n * 3600 * 1000;
  return n * 86400 * 1000; // d/д
}

function fmtDuration(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м`;
  return `${Math.max(1, Math.round(ms / 1000))}с`;
}

function fmtDate(ts) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(ts));
}

function needPerm() {
  // права теперь по стафф-ролям (см. handle): оставлено для совместимости вызовов purge/nickname
  return true;
}

async function targetMember(message, token, { mustBeMember = true } = {}) {
  const id = parseId(token);
  if (!id) {
    await message.reply("⚠️ Укажите пользователя (@упоминание или ID).");
    return null;
  }
  if (id === message.guild.ownerId) {
    await message.reply("❌ Нельзя применить к владельцу сервера.");
    return null;
  }
  let member = null;
  try {
    member = await message.guild.members.fetch(id);
  } catch {
    member = null;
  }
  if (!member && mustBeMember) {
    await message.reply("❌ Пользователь не найден на сервере (для действия по ID вне сервера есть `c.forceban`/`c.unban`).");
    return null;
  }
  return { id, member };
}

function hierarchyOk(message, member) {
  const me = message.guild.members.me;
  if (member && me && member.roles.highest.position >= me.roles.highest.position) {
    return false;
  }
  return true;
}

/* ---------- инфракции (предупреждения) ---------- */

function loadInfractions() {
  return loadJson(INF_FILE, { list: [] });
}

function saveInfractions(data) {
  saveJson(INF_FILE, data);
}

function nextInfId(data) {
  return data.list.length ? data.list[data.list.length - 1].id + 1 : 1;
}

function infLine(inf) {
  return `**#${inf.id}** — <@${inf.userId}> | ${inf.reason} | от <@${inf.moderatorId}> | ${fmtDate(inf.createdAt)} МСК`;
}

async function cmdInfractions(message, args) {
  const sub = (args[0] || "").toLowerCase();
  const data = loadInfractions();

  if (sub === "info") {
    const id = Number(args[1]);
    const inf = data.list.find((x) => x.id === id);
    if (!inf) return message.reply(`❌ Инфракция #${args[1]} не найдена.`);
    return message.reply(infLine(inf));
  }
  if (sub === "search") {
    const id = parseId(args[1]) || message.author.id;
    const list = data.list.filter((x) => x.userId === id && x.guildId === message.guildId);
    if (!list.length) return message.reply(`У <@${id}> нет инфракций.`);
    return message.reply(`Инфракции <@${id}> (${list.length}):\n` + list.map(infLine).join("\n"));
  }
  if (sub === "modsearch") {
    const id = parseId(args[1]) || message.author.id;
    const list = data.list.filter((x) => x.moderatorId === id && x.guildId === message.guildId);
    if (!list.length) return message.reply(`У модератора <@${id}> нет выданных инфракций.`);
    return message.reply(`Инфракции, выданные <@${id}> (${list.length}):\n` + list.map(infLine).join("\n"));
  }
  if (sub === "delete") {
    const id = Number(args[1]);
    const i = data.list.findIndex((x) => x.id === id);
    if (i === -1) return message.reply(`❌ Инфракция #${args[1]} не найдена.`);
    data.list.splice(i, 1);
    saveInfractions(data);
    return message.reply(`✅ Инфракция #${id} удалена.`);
  }
  if (sub === "update") {
    const id = Number(args[1]);
    const reason = args.slice(2).join(" ").trim();
    const inf = data.list.find((x) => x.id === id);
    if (!inf) return message.reply(`❌ Инфракция #${args[1]} не найдена.`);
    if (!reason) return message.reply("⚠️ Укажите новую причину: `c.infractions update <id> <причина>`");
    inf.reason = reason;
    saveInfractions(data);
    return message.reply(`✅ Инфракция #${id} обновлена: ${infLine(inf)}`);
  }
  return message.reply(
    "Формат: `c.infractions search [@user]` | `c.infractions modsearch [@mod]` | `c.infractions info <id>` | `c.infractions delete <id>` | `c.infractions update <id> <причина>`"
  );
}

/* ---------- временные роли ---------- */

function loadTempRoles() {
  return loadJson(TR_FILE, { list: [] });
}

function saveTempRoles(data) {
  saveJson(TR_FILE, data);
}

async function cmdTempRole(client, message, args, gateTarget) {
  const sub = (args[0] || "").toLowerCase();
  const data = loadTempRoles();

  if (sub === "add") {
    const target = await targetMember(message, args[1]);
    if (!target || !target.member) return;
    if (!(await gateTarget(target.member))) return;
    const roleId = parseId(args[2]);
    const ms = parseTime(args[3]);
    if (!roleId || !ms) {
      return message.reply("Формат: `c.temp-role add @user @роль <время>` — например `c.temp-role add @user @VIP 2h`");
    }
    let role;
    try {
      role = await message.guild.roles.fetch(roleId);
    } catch {
      role = null;
    }
    if (!role) return message.reply("❌ Роль не найдена.");
    const me = message.guild.members.me;
    if (role.position >= me.roles.highest.position) return message.reply("❌ Роль выше моей — не могу выдать.");
    try {
      await target.member.roles.add(role, `temp-role от ${message.author.tag}`);
    } catch (e) {
      return message.reply(`❌ Не удалось выдать роль: \`${e.message}\``);
    }
    data.list.push({
      id: data.list.length ? data.list[data.list.length - 1].id + 1 : 1,
      guildId: message.guildId,
      userId: target.id,
      roleId,
      until: Date.now() + ms,
      moderatorId: message.author.id
    });
    saveTempRoles(data);
    return message.reply(`✅ Роль **${role.name}** выдана <@${target.id}> на **${fmtDuration(ms)}** (до ${fmtDate(Date.now() + ms)} МСК).`);
  }

  if (sub === "reduce") {
    const target = await targetMember(message, args[1]);
    if (!target) return;
    if (!(await gateTarget(target.member))) return;
    const roleId = parseId(args[2]);
    const ms = parseTime(args[3]);
    if (!roleId || !ms) {
      return message.reply("Формат: `c.temp-role reduce @user @роль <время>` — сократить срок, например `1h`");
    }
    const rec = data.list.find((x) => x.guildId === message.guildId && x.userId === target.id && x.roleId === roleId);
    if (!rec) return message.reply("❌ Активная временная роль не найдена.");
    rec.until -= ms;
    if (rec.until <= Date.now()) {
      const m = target.member;
      if (m) await m.roles.remove(roleId).catch(() => {});
      data.list.splice(data.list.indexOf(rec), 1);
      saveTempRoles(data);
      return message.reply("✅ Срок сокращён до нуля — роль снята.");
    }
    saveTempRoles(data);
    return message.reply(`✅ Срок сокращён на ${fmtDuration(ms)}: теперь до ${fmtDate(rec.until)} МСК (осталось ${fmtDuration(rec.until - Date.now())}).`);
  }

  if (sub === "list") {
    const list = data.list.filter((x) => x.guildId === message.guildId);
    if (!list.length) return message.reply("Активных временных ролей нет.");
    const lines = list.map((x) => {
      const left = x.until - Date.now();
      return `**#${x.id}** — <@${x.userId}> роль <@&${x.roleId}> — осталось ${left > 0 ? fmtDuration(left) : "просрочено"} (до ${fmtDate(x.until)} МСК)`;
    });
    return message.reply("Временные роли:\n" + lines.join("\n"));
  }

  return message.reply("Формат: `c.temp-role add @user @роль <время>` | `c.temp-role reduce @user @роль <время>` | `c.temp-role list`");
}

// Фоновая проверка: снять просроченные временные роли (вызывается по таймеру)
async function checkTempRoles(client) {
  const data = loadTempRoles();
  if (!data.list.length) return;
  const now = Date.now();
  const expired = data.list.filter((x) => x.until <= now);
  if (!expired.length) return;
  for (const rec of expired) {
    try {
      const guild = await client.guilds.fetch(rec.guildId);
      const member = await guild.members.fetch(rec.userId).catch(() => null);
      if (member) await member.roles.remove(rec.roleId).catch(() => {});
    } catch (e) {
      console.error("[temp-role] снятие:", e && e.message ? e.message : e);
    }
    data.list.splice(data.list.indexOf(rec), 1);
  }
  saveTempRoles(data);
}

/* ---------- purge ---------- */

async function purgeFetch(message, limit) {
  return message.channel.messages.fetch({ limit: Math.min(100, Math.max(1, limit)) });
}

async function cmdPurge(message, args) {
  if (!needPerm(message, "ManageMessages", "Управление сообщениями")) return;
  const sub = (args[0] || "all").toLowerCase();

  const numArg = Number(args[args.length - 1]);
  const count = Number.isInteger(numArg) && numArg > 0 ? Math.min(100, numArg) : 10;

  if (sub === "all") {
    const deleted = await message.channel.bulkDelete(count, true);
    return message.reply(`🧹 Удалено сообщений: **${deleted.size}**.`);
  }
  if (sub === "user") {
    const id = parseId(args[1]);
    if (!id) return message.reply("Формат: `c.purge user @user [N]`");
    const msgs = await purgeFetch(message, 100);
    const mine = [...msgs.values()].filter((m) => m.author.id === id).slice(0, count);
    if (!mine.length) return message.reply("Сообщений этого пользователя в последних 100 не найдено.");
    const deleted = await message.channel.bulkDelete(mine, true);
    return message.reply(`🧹 Удалено сообщений от <@${id}>: **${deleted.size}**.`);
  }
  if (sub === "images") {
    const msgs = await purgeFetch(message, 100);
    const mine = [...msgs.values()].filter((m) => m.attachments.size > 0).slice(0, count);
    if (!mine.length) return message.reply("Сообщений с вложениями в последних 100 не найдено.");
    const deleted = await message.channel.bulkDelete(mine, true);
    return message.reply(`🧹 Удалено сообщений с вложениями: **${deleted.size}**.`);
  }
  if (sub === "emojis") {
    const msgs = await purgeFetch(message, 100);
    const mine = [...msgs.values()].filter((m) => /<a?:\w+:\d+>/.test(m.content)).slice(0, count);
    if (!mine.length) return message.reply("Сообщений с кастомными эмодзи в последних 100 не найдено.");
    const deleted = await message.channel.bulkDelete(mine, true);
    return message.reply(`🧹 Удалено сообщений с эмодзи: **${deleted.size}**.`);
  }
  if (sub === "between") {
    const id1 = parseId(args[1]);
    const id2 = parseId(args[2]);
    if (!id1 || !id2) return message.reply("Формат: `c.purge between <ID сообщения 1> <ID сообщения 2>` — удалит сообщения между ними.");
    const [a, b] = [id1, id2].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    const msgs = await message.channel.messages.fetch({ after: a, before: b, limit: 100 });
    if (!msgs.size) return message.reply("Между указанными сообщениями ничего нет (или сообщения старше 14 дней).");
    const deleted = await message.channel.bulkDelete(msgs, true);
    return message.reply(`🧹 Удалено сообщений между: **${deleted.size}**.`);
  }
  return message.reply("Формат: `c.purge all [N]` | `c.purge user @user [N]` | `c.purge images [N]` | `c.purge emojis [N]` | `c.purge between <id1> <id2>`");
}

/* ---------- nickname ---------- */

async function cmdNickname(message, args, gateTarget) {
  const sub = (args[0] || "").toLowerCase();

  if (sub === "set") {
    const target = await targetMember(message, args[1]);
    if (!target || !target.member) return;
    if (!(await gateTarget(target.member))) return;
    const nick = args.slice(2).join(" ").trim();
    if (!nick) return message.reply("Формат: `c.nickname set @user <новый ник>`");
    if (!hierarchyOk(message, target.member)) return message.reply("❌ Его роль не ниже моей — ник не изменить.");
    await target.member.setNickname(nick, `от ${message.author.tag}`);
    return message.reply(`✅ Ник <@${target.id}> изменён на **${nick}**.`);
  }
  if (sub === "reset") {
    const target = await targetMember(message, args[1]);
    if (!target || !target.member) return;
    if (!(await gateTarget(target.member))) return;
    if (!hierarchyOk(message, target.member)) return message.reply("❌ Его роль не ниже моей — ник не изменить.");
    await target.member.setNickname(null, `сброс от ${message.author.tag}`);
    return message.reply(`✅ Ник <@${target.id}> сброшен.`);
  }
  if (sub === "history") {
    const target = await targetMember(message, args[1], { mustBeMember: false });
    if (!target) return;
    let entries = [];
    try {
      const logs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 50 });
      entries = [...logs.entries.values()].filter(
        (e) => e.target && e.target.id === target.id && e.changes.some((c) => c.key === "nick")
      );
    } catch {
      return message.reply("❌ Нет доступа к журналу аудита (нужно право «Просмотр журнала аудита» у бота).");
    }
    if (!entries.length) return message.reply(`История ников <@${target.id}> пуста (в пределах журнала аудита).`);
    const lines = entries.slice(0, 5).map((e) => {
      const ch = e.changes.find((c) => c.key === "nick");
      return `• ${ch.old ?? "—"} → **${ch.new ?? "—"}** | от ${e.executor ? e.executor.tag : "?"} | ${fmtDate(e.createdTimestamp)} МСК`;
    });
    return message.reply(`История ников <@${target.id}>:\n` + lines.join("\n"));
  }
  return message.reply("Формат: `c.nickname set @user <ник>` | `c.nickname reset @user` | `c.nickname history @user`");
}

/* ---------- главный обработчик ---------- */

const MOD_COMMANDS = new Set([
  "ban", "forceban", "crossban", "unban", "kick", "mute", "unmute",
  "pardon", "strike", "strikes", "purge", "nickname", "infractions", "temp-role"
]);

async function handle(client, message, cmd, args) {
  if (!MOD_COMMANDS.has(cmd)) return false;

  // Доступ к модерации — только по стафф-ролям
  if (staffRank(message.member) === -1) {
    await message.reply("❌ Недостаточно прав.");
    return true;
  }

  // Проверка иерархии цели (роль цели должна быть НИЖЕ роли автора)
  const gateTarget = async (member) => {
    if (!targetRankOk(message, member)) {
      await message.reply("❌ Недостаточно прав.");
      return false;
    }
    return true;
  };

  const rest = (n) => args.slice(n).join(" ").trim();

  switch (cmd) {
    case "ban": {
      const target = await targetMember(message, args[0]);
      if (!target) return true;
      if (!(await gateTarget(target.member))) return true;
      if (target.member && !target.member.bannable) { await message.reply("❌ Не могу забанить — его роль не ниже моей."); return true; }
      const reason = rest(1) || "Без причины";
      await message.guild.members.ban(target.id, { reason: `${reason} — ${message.author.tag}` });
      await message.reply(`🔨 <@${target.id}> забанен. Причина: ${reason}`);
      return true;
    }
    case "forceban": {
      const id = parseId(args[0]);
      if (!id) { await message.reply("Формат: `c.forceban <ID> [причина]` — бан по ID, даже если пользователя нет на сервере."); return true; }
      const member = await message.guild.members.fetch(id).catch(() => null);
      if (!(await gateTarget(member))) return true;
      const reason = rest(1) || "Без причины";
      try {
        await message.guild.members.ban(id, { reason: `${reason} — ${message.author.tag}` });
        await message.reply(`🔨 ID \`${id}\` забанен принудительно. Причина: ${reason}`);
      } catch (e) {
        await message.reply(`❌ Не удалось: \`${e.message}\``);
      }
      return true;
    }
    case "crossban": {
      const id = parseId(args[0]);
      if (!id) { await message.reply("Формат: `c.crossban <ID> [причина]` — бан на всех серверах, где есть бот."); return true; }
      const member = await message.guild.members.fetch(id).catch(() => null);
      if (!(await gateTarget(member))) return true;
      const reason = rest(1) || "Без причины";
      const results = [];
      for (const guild of client.guilds.cache.values()) {
        try {
          await guild.members.ban(id, { reason: `crossban: ${reason} — ${message.author.tag}` });
          results.push(`✅ ${guild.name}`);
        } catch (e) {
          results.push(`❌ ${guild.name} (${e.message})`);
        }
      }
      await message.reply(`Кроссбан \`${id}\`:\n` + results.join("\n"));
      return true;
    }
    case "kick": {
      const target = await targetMember(message, args[0]);
      if (!target || !target.member) return true;
      if (!(await gateTarget(target.member))) return true;
      if (!target.member.kickable) { await message.reply("❌ Не могу кикнуть — его роль не ниже моей."); return true; }
      const reason = rest(1) || "Без причины";
      await target.member.kick(`${reason} — ${message.author.tag}`);
      await message.reply(`👢 <@${target.id}> кикнут. Причина: ${reason}`);
      return true;
    }
    case "mute": {
      const target = await targetMember(message, args[0]);
      if (!target || !target.member) return true;
      if (!(await gateTarget(target.member))) return true;
      if (!target.member.moderatable) { await message.reply("❌ Не могу замутить — его роль не ниже моей."); return true; }
      let ms = parseTime(args[1]);
      let reasonArgs = args.slice(1);
      if (ms) reasonArgs = args.slice(2);
      else ms = 10 * 60 * 1000; // по умолчанию 10 минут
      ms = Math.min(ms, 28 * 86400 * 1000); // лимит Discord — 28 дней
      const reason = reasonArgs.join(" ").trim() || "Без причины";
      await target.member.timeout(ms, `${reason} — ${message.author.tag}`);
      await message.reply(`🔇 <@${target.id}> замучен на **${fmtDuration(ms)}**. Причина: ${reason}`);
      return true;
    }
    case "unmute": {
      const target = await targetMember(message, args[0]);
      if (!target || !target.member) return true;
      if (!(await gateTarget(target.member))) return true;
      await target.member.timeout(null, `размут от ${message.author.tag}`);
      await message.reply(`🔊 <@${target.id}> размучен.`);
      return true;
    }
    case "unban": {
      const id = parseId(args[0]);
      if (!id) { await message.reply("Формат: `c.unban <ID> [причина]`"); return true; }
      const member = await message.guild.members.fetch(id).catch(() => null);
      if (!(await gateTarget(member))) return true;
      const reason = rest(1) || "Без причины";
      try {
        await message.guild.members.unban(id, `${reason} — ${message.author.tag}`);
        await message.reply(`✅ ID \`${id}\` разбанен.`);
      } catch (e) {
        await message.reply(`❌ Не удалось: \`${e.message}\``);
      }
      return true;
    }
    case "pardon": {
      const target = await targetMember(message, args[0], { mustBeMember: false });
      if (!target) return true;
      if (!(await gateTarget(target.member))) return true;
      const data = loadInfractions();
      const before = data.list.length;
      data.list = data.list.filter((x) => !(x.userId === target.id && x.guildId === message.guildId));
      saveInfractions(data);
      await message.reply(`✅ <@${target.id}> помилован — снято инфракций: **${before - data.list.length}**.`);
      return true;
    }
    case "strike": {
      const target = await targetMember(message, args[0], { mustBeMember: false });
      if (!target) return true;
      if (!(await gateTarget(target.member))) return true;
      const reason = rest(1) || "Без причины";
      const data = loadInfractions();
      const id = nextInfId(data);
      data.list.push({
        id,
        guildId: message.guildId,
        userId: target.id,
        moderatorId: message.author.id,
        reason,
        createdAt: Date.now()
      });
      saveInfractions(data);
      const total = data.list.filter((x) => x.userId === target.id && x.guildId === message.guildId).length;
      await message.reply(`⚠️ Предупреждение **#${id}** выдано <@${target.id}>: ${reason} (всего: ${total})`);
      return true;
    }
    case "strikes": {
      const data = loadInfractions();
      const id = parseId(args[0]) || message.author.id;
      const list = data.list.filter((x) => x.userId === id && x.guildId === message.guildId);
      if (!list.length) { await message.reply(`У <@${id}> нет предупреждений.`); return true; }
      await message.reply(`Предупреждения <@${id}> (${list.length}):\n` + list.map(infLine).join("\n"));
      return true;
    }
    case "purge": return cmdPurge(message, args).then(() => true);
    case "nickname": return cmdNickname(message, args, gateTarget).then(() => true);
    case "infractions": {
      return cmdInfractions(message, args).then(() => true);
    }
    case "temp-role": {
      return cmdTempRole(client, message, args, gateTarget).then(() => true);
    }
    default:
      return false; // неизвестная c.-команда — молчим
  }
}

module.exports = { handle, checkTempRoles };
