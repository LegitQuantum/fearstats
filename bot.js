"use strict";

// Discord-бот ModStatsFear.
// Команды:
//   !stats                          — статистика наказаний за текущий месяц (МСК)
//   !mod_add <SteamID> [имя]        — добавить в отслеживание (ранг 1)
//   !mod_del <SteamID>              — убрать из отслеживания
//   !swap_rank <SteamID...> <1-4>   — назначить ранг (1=мл, 2=мод, 3=ст, 4=админ); новых добавит
//   !norma [<1-4> <нед>/<мес>]      — показать/изменить нормы рангов ("-" = нормы нет)
//   !m <команда>                    — запрос команды от любого пользователя (кнопки в ЛС владельцу)
// Статистика также автообновляется и отправляется в канал каждые 10 минут.
//
// Токен берётся из переменной окружения DISCORD_TOKEN
// или из config.json: { "discordToken": "..." }
//
// Важно: в Discord Developer Portal у бота должен быть включён
// "Message Content Intent" (Bot -> Privileged Gateway Intents).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Partials } = require("discord.js");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = require("@discordjs/voice");
const { Readable } = require("stream");
const { refreshStats, buildStatsThorough, saveCache, loadCache, analyzeVdf, findSuspects } = require("./fetcher");
const { buildEmbed, buildNormsText, fmtTime, completion } = require("./stats-embed");
const store = require("./store");
const interactions = require("./interactions");
const moderation = require("./moderation");

const SCHEDULE_STEP_MS = 10 * 60 * 1000; // публикация по расписанию: :00, :10, :20, :30, :40, :50

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  } catch {
    return {}; // нет config.json
  }
}

const config = loadConfig();
const token = process.env.DISCORD_TOKEN || config.discordToken;

// ID каналов, где бот отвечает на !stats (через запятую). Пусто = все каналы.
const allowedChannels = String(process.env.CHANNEL_ID || config.channelId || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ID владельцев, чьи команды обрабатывает бот. Пусто = все пользователи.
const ownerIds = Array.isArray(config.ownerIds) && config.ownerIds.length
  ? config.ownerIds.map(String)
  : config.ownerId
    ? [String(config.ownerId)]
    : [];

// ID пользователей, чьи !m-запросы одобряются автоматически (без кнопок в ЛС)
const autoApprove = Array.isArray(config.autoApprove) ? config.autoApprove.map(String) : [];

// Канал запросов: !m работает только в нём. Пусто = !m в любом канале.
const requestChannelId = String(config.requestChannelId || "").trim();

// Пользователи за слежением: уведомления владельцам при выходе в сеть и входе в голос
const watchUsers = Array.isArray(config.watchUsers) ? config.watchUsers.map(String) : [];

// Канал для оповещений о подозрении в читах (новички < 2ч с K/D > 2)
const suspectChannelId = String(config.suspectChannelId || "").trim();



// Дополнительные пользователи для dot-команд (владельцы имеют доступ и так)
const bolotniyUsers = Array.isArray(config.bolotniyUsers) ? config.bolotniyUsers.map(String) : [];

// Dot-команды и их тексты
const DOT_COMMANDS = {
  ".болотный": "Чума болотная хуесос ебучий",
  ".работа": "Идите работать на FEAR суки!"
};

// Команды, на которые бот отвечает инструкцией про !m (для обычных пользователей)
const KNOWN_COMMANDS = new Set([
  "!stats", "!reload", "!clear", "!mod_add", "!add_mod", "!mod_del", "!del_mod",
  "!swap_rank", "!norma", "!name", "!discord", "!info", "!discords",
  "!specstats", "!unspec", "!dmtest", "!vdf", "!help", "!помощь"
]);

// Учёт уже отправленных объявлений "Модератор ... выполнил норму"
const STATE_FILE = path.join(__dirname, "data", "state.json");
const MSK = 3 * 3600;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function clearAnnounced(steamid) {
  const state = loadState();
  if (state.announcedMonth) delete state.announcedMonth[steamid];
  if (state.announcedWeek) delete state.announcedWeek[steamid];
  saveState(state);
}

let stats = loadCache();
let refreshing = false;
let thoroughRunning = false; // идёт тщательный пересчёт (!reload)
const pendingRequests = new Map(); // id запроса !m -> { userId, userTag, command, createdAt }
let requestSeq = 1;
// channelId -> id последнего поста со статистикой (переживает перезапуск через state.json)
const lastPostByChannel = new Map(Object.entries(loadState().lastPost || {}));

function saveLastPost() {
  const state = loadState();
  state.lastPost = Object.fromEntries(lastPostByChannel);
  saveState(state);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    stats = await refreshStats(); // возьмёт свежий кэш, если сайт уже сканировал
    console.log(`[бот] Статистика обновлена: ${stats.totals.total} наказаний (${stats.month})`);
  } catch (e) {
    console.error("[бот] Ошибка обновления:", e && e.message ? e.message : e);
  } finally {
    refreshing = false;
  }
}

if (!token) {
  console.error(
    "Не найден токен бота.\n" +
    "Укажите его в переменной окружения DISCORD_TOKEN или создайте config.json:\n" +
    '{ "discordToken": "ВАШ_ТОКЕН" }'
  );
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages, // приём config.vdf и команд владельца в ЛС
    GatewayIntentBits.GuildPresences, // статусы (включить Presence Intent в Dev Portal!)
    GatewayIntentBits.GuildVoiceStates // голосовые каналы
  ],
  partials: [Partials.Channel] // иначе события ЛС не приходят
});

// Автоотправка статистики: удаляет прошлый пост бота и шлёт новый.
// Текст норм — вне эмбеда.
async function autoPost() {
  if (!stats || !allowedChannels.length) return;
  const embed = buildEmbed(stats);
  const content = buildNormsText(stats) || "";
  for (const channelId of allowedChannels) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.error(`[бот] Канал ${channelId} не найден или не текстовый`);
        continue;
      }
      const lastId = lastPostByChannel.get(channelId);
      if (lastId) {
        try {
          const prev = await channel.messages.fetch(lastId);
          await prev.delete();
        } catch { /* уже удалено — просто шлём новое */ }
      }
      const msg = await channel.send({ content, embeds: [embed] });
      lastPostByChannel.set(channelId, msg.id);
      saveLastPost();
      console.log(`[бот] Статистика отправлена в канале ${channelId}`);
    } catch (e) {
      console.error(`[бот] Ошибка отправки в канал ${channelId}:`, e && e.message ? e.message : e);
    }
  }
}

// Разовое объявление, когда модератор выполнил норму
// (месячную; если задана только недельная — то её). Проценты считаются дальше 100%.
async function checkAnnouncements() {
  if (!stats || !stats.weekStart || !stats.monthStart || !allowedChannels.length) return;
  const state = loadState();
  state.announcedMonth = state.announcedMonth || {};
  state.announcedWeek = state.announcedWeek || {};
  const monthKey = new Date((stats.monthStart + MSK) * 1000).toISOString().slice(0, 7); // "2026-08"
  const weekKey = new Date((stats.weekStart + MSK) * 1000).toISOString().slice(0, 10); // "2026-08-03"

  for (const m of stats.moderators) {
    if (!m.norma) continue;
    const byMonth = m.norma.month > 0;
    const done = byMonth
      ? m.total >= m.norma.month
      : m.norma.week > 0 && m.weekTotal >= m.norma.week;
    if (!done) continue;
    const book = byMonth ? state.announcedMonth : state.announcedWeek;
    const key = byMonth ? monthKey : weekKey;
    if (book[m.steamid] === key) continue; // уже объявляли в этом периоде

    const progress =
      (m.norma.month > 0 ? `месяц **${m.total}/${m.norma.month}**` : "") +
      (m.norma.month > 0 && m.norma.week > 0 ? ", " : "") +
      (m.norma.week > 0 ? `неделя **${m.weekTotal}/${m.norma.week}**` : "");

    for (const channelId of allowedChannels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          await channel.send(`Модератор **${m.name}** выполнил норму`);
        }
      } catch (e) {
        console.error(`[бот] Ошибка объявления в канал ${channelId}:`, e && e.message ? e.message : e);
      }
    }

    // ЛС обоим владельцам об успешном выполнении нормы
    for (const oid of ownerIds) {
      try {
        const owner = await client.users.fetch(oid);
        await owner.send(`🎉 Модератор **${m.name}**${store.rankTitle(m.rank) ? ` (${store.rankTitle(m.rank)})` : ""} выполнил норму: ${progress}`);
      } catch (e) {
        console.error(`[бот] Не удалось отправить ЛС владельцу ${oid}:`, e && e.message ? e.message : e);
      }
    }

    book[m.steamid] = key;
    console.log(`[бот] Объявление: ${m.name} выполнил норму (${key})`);
  }
  saveState(state);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Полная очистка канала: сообщения младше 14 дней — пакетно (bulkDelete),
// старше 14 дней — по одному (ограничение API Discord).
async function clearChannel(channel) {
  let total = 0;
  for (let guard = 0; guard < 50; guard++) {
    const msgs = await channel.messages.fetch({ limit: 100 });
    if (!msgs.size) break;
    const before = total;
    const fresh = [...msgs.values()].filter((m) => Date.now() - m.createdTimestamp < 13.5 * 86400e3);
    const old = [...msgs.values()].filter((m) => Date.now() - m.createdTimestamp >= 13.5 * 86400e3);
    if (fresh.length === 1) {
      try { await fresh[0].delete(); total++; } catch { /* нет прав */ }
    } else if (fresh.length > 1) {
      try {
        const deleted = await channel.bulkDelete(fresh, true);
        total += deleted.size;
      } catch {
        for (const m of fresh) { try { await m.delete(); total++; } catch { /* пропуск */ } await sleep(250); }
      }
    }
    for (const m of old) { try { await m.delete(); total++; } catch { /* пропуск */ } await sleep(250); }
    if (total === before) break; // ничего не удалилось (нет прав?) — выходим
  }
  return total;
}

async function clearChannels() {
  for (const channelId of allowedChannels) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) continue;
      const n = await clearChannel(channel);
      console.log(`[бот] Канал ${channelId} очищен: удалено ${n} сообщений`);
    } catch (e) {
      console.error(`[бот] Ошибка очистки канала ${channelId}:`, e && e.message ? e.message : e);
    }
  }
}

async function tick() {
  await refresh();
  await notifySpecsubs(); // рассылка подписчикам при изменении статистики
  await checkAnnouncements();
  await autoPost();
}

// Планирует цикл ровно на ближайшую круглую десятиминутку:
//   -65 сек — обновление данных с сайта (скан идёт ~40-60 сек)
//   -10 сек — полная очистка канала
//    :00    — объявления + новый пост
// Не зависит от времени запуска бота и не сбрасывается командами.
function scheduleTick() {
  const now = Date.now();
  const next = Math.ceil((now + 1000) / SCHEDULE_STEP_MS) * SCHEDULE_STEP_MS;
  const at = (ts, fn) => setTimeout(fn, Math.max(ts - Date.now(), 0));

  at(next - 65000, async () => {
    if (thoroughRunning) {
      console.log("[бот] Плановый цикл пропущен: идёт тщательный пересчёт (!reload)");
      scheduleTick();
      return;
    }
    await refresh();
    at(next - 10000, async () => {
      await clearChannels();
      at(next, async () => {
        await checkAnnouncements();
        await autoPost();
        scheduleTick();
      });
    });
  });

  console.log(
    `[бот] Следующий пост по расписанию: ${new Date(next).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК (очистка канала за 10 сек)`
  );
}

// Мгновенно применяет изменения списка (имена/ранги/нормы/добавление/удаление)
// к текущему снимку, не дожидаясь полного пересчёта.
function patchStats() {
  if (!stats) return;
  const mods = store.load();
  stats.moderators = stats.moderators.filter((sm) => mods.some((m) => m.steamid === sm.steamid));
  for (const sm of stats.moderators) {
    const src = mods.find((m) => m.steamid === sm.steamid);
    sm.rank = src.rank ?? null;
    sm.norma = store.rankNorm(sm.rank);
    if (src.name !== src.steamid) sm.name = src.name;
  }
  for (const m of mods) {
    if (!stats.moderators.some((sm) => sm.steamid === m.steamid)) {
      stats.moderators.push({
        name: m.name, steamid: m.steamid, rank: m.rank ?? null, norma: store.rankNorm(m.rank),
        lastSeenName: null, bans: 0, mutes: 0, total: 0, weekTotal: 0, removed: 0, excluded: 0, records: []
      });
    }
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`[бот] Вошёл как ${c.user.tag}`);
  if (ownerIds.length) {
    console.log(`[бот] Команды принимаю только от владельцев: ${ownerIds.join(", ")}`);
  }
  if (autoApprove.length) {
    console.log(`[бот] Автоодобрение !m для: ${autoApprove.join(", ")}`);
  }
  if (allowedChannels.length) {
    console.log(`[бот] Отвечаю только в каналах: ${allowedChannels.join(", ")}`);
  } else {
    console.log("[бот] channelId не задан — автоотправка выключена, отвечаю на !stats в любом канале");
  }
  if (requestChannelId) {
    console.log(`[бот] Запросы !m принимаю только в канале: ${requestChannelId}`);
  }
  tick(); // первый пост сразу при запуске
  scheduleTick(); // дальше — строго по расписанию :00/:10/:20/:30/:40/:50
  processScheduledMsgs(); // доотправить отложенные сообщения после рестарта
  setInterval(processScheduledMsgs, 15000);
  scheduleZavDaily(); // ежедневный вопрос !zav в 6:00 МСК
  setInterval(checkZav, 60 * 1000); // проверка 72ч тишины раз в минуту
  setTimeout(checkSuspects, 90 * 1000); // первый прогон подозрительных через 1.5 мин
  setInterval(checkSuspects, 10 * 60 * 1000); // дальше каждые 10 минут
  setInterval(() => moderation.checkTempRoles(client), 60 * 1000); // снятие просроченных temp-ролей

  // веб-панель управления
  require("./panel/server").start({
    client,
    config,
    store,
    loadCache,
    loadState,
    saveState,
    speakInConnection,
    findVoiceConnection
  });
});

const STEAMID_RE = /^\d{17}$/;

const HELP_TEXT =
  "**Команды бота:**\n" +
  "`!stats` — статистика наказаний за текущий месяц (МСК)\n" +
  "`!mod_add <SteamID> [имя]` — добавить модератора (сразу ранг 1)\n" +
  "`!mod_del <SteamID>` — убрать из отслеживания\n" +
  "`!swap_rank <SteamID...> <ранг>` — назначить ранг одному или нескольким (кого нет — добавятся)\n" +
  "`!norma` — показать нормы рангов\n" +
  "`!norma <ранг> <нед>/<мес>` — изменить норму ранга (`-` = нормы нет)\n" +
  "`!name <SteamID> <НИК>` — задать отображаемое имя в таблице\n" +
  "`!discord <SteamID> <ник>` — привязать Discord (в таблице не виден)\n" +
  "`!info <SteamID>` — SteamID, Discord, ссылка на профиль\n" +
  "`!discords` — список привязок Discord (— = не привязан)\n" +
  "`!specstats <SteamID>` — статистика модератора вам в ЛС при изменениях\n" +
  "`!unspec` — остановить отслеживание в ЛС\n" +
  "`!dmtest <ID>` — проверить доставку ЛС пользователю\n" +
  "`!msg <ID|юзернейм> <текст> [дата/время]` — ЛС от бота (в вашем ЛС)\n" +
  "`!msgc <каналID> <текст> [дата/время]` — сообщение от бота в канал (в вашем ЛС)\n" +
  "`!msgall <каналID> (<цель>) <текст> [дата/время]` — то же с упоминаниями: ID/юзернейм/everyone, можно несколько\n" +
  "`!reload` — тщательный пересчёт (5 проходов) и свежий пост\n" +
  "`!clear` — очистить канал и опубликовать статистику заново\n" +
  "`!m <команда>` — запрос команды (только в канале запросов, на одобрение владельцу)\n" +
  "`!vdf` — проверка config.vdf на баны (в канале запросов, файл — в ЛС)\n" +
  "`!help` — эта справка\n\n" +
  "**Ранги:** `1` — мл. Модератор, `2` — Модератор, `3` — ст. Модератор, `4` — ст. Администратор, `5` — Стафф\n" +
  "Примеры: `!swap_rank 76561199559786627 76561199566639200 2`, `!norma 3 -/50`";

const HELP_HINT = "\nВсе команды: `!help`";

// Полная справка для владельца в ЛС
const DM_HELP_TEXT =
  "**📖 Команды владельца**\n\n" +
  "**В этом ЛС:**\n" +
  "`!msg <ID|юзернейм> <текст> [дата/время]` — ЛС пользователю от бота (анонимно)\n" +
  "`!msgc <каналID> <текст> [дата/время]` — сообщение от бота в канал\n" +
  "`!msgall <каналID> (<цель>) <текст> [дата/время]` — в канал с упоминаниями (ID/юзернейм/everyone, можно несколько)\n" +
  "`!warnnorma <ID> [нед/мес рангID]` — предупреждение о невыполнении нормы\n" +
  "`!zav` — ежедневная проверка состояния в 6:00 МСК (`!zav off` — стоп)\n" +
  "`!voice <каналID>` — бот заходит в войс и сидит там (`!voice off` — выйти)\n" +
  "`!say [каналID] <текст>` — бот произносит текст в войсе\n" +
  "`!help` — эта справка\n" +
  "_Дата/время по МСК: `05.08.2026 15:00` или `05.08.2026` (00:00); без даты — сразу; у отложенных — кнопка отмены._\n\n" +
  "**В основном канале:**\n" +
  "`!stats` — статистика за месяц • `!reload` — тщательный пересчёт (5 проходов) • `!clear` — очистить канал и пост заново\n" +
  "`!mod_add <SteamID> [имя]` • `!mod_del <SteamID>` • `!swap_rank <SteamID...> <1-5>` • `!norma [<1-5> <нед>/<мес>]`\n" +
  "`!name <SteamID> <НИК>` • `!discord <SteamID> <ник>` • `!info <SteamID>` • `!discords`\n" +
  "`!specstats <SteamID>` — статистика модератора вам в ЛС при изменениях • `!unspec` — стоп\n" +
  "`!dmtest <ID>` — проверка доставки ЛС пользователю\n\n" +
  "**В канале запросов:**\n" +
  "`!m <команда>` — запросы от пользователей на ваше одобрение (кнопки в ЛС)\n" +
  "`!vdf` — проверка config.vdf на баны (бот ждёт файл в ЛС)\n\n" +
  "**Автоматика:** посты :00/:10/.../:50 (очистка канала за 10 сек), объявления о выполнении нормы, уведомления об онлайне и войсе отслеживаемых.";

async function cmdStats(message) {
  if (thoroughRunning) {
    await message.reply("⏳ Идёт тщательный пересчёт (!reload), статистика скоро появится.");
    return;
  }
  if (!stats) {
    refresh();
    await message.reply("⏳ Собираю данные с fearproject.ru, попробуйте ещё раз через минуту.");
    return;
  }
  const embed = buildEmbed(stats);
  if (refreshing) {
    embed.setFooter({
      text: `Обновлено ${fmtTime.format(new Date(stats.updatedAt * 1000))} МСК • идёт обновление данных…`
    });
  }
  await message.channel.send({ content: buildNormsText(stats) || "", embeds: [embed] });
}

// !mod_add <SteamID64> [имя]  — новый модератор сразу получает ранг 1 (мл. Модератор)
async function cmdModAdd(message, args) {
  const steamid = args[1] || "";
  if (!STEAMID_RE.test(steamid)) {
    await message.reply("Формат: `!mod_add <SteamID64> [имя]`\nПример: `!mod_add 76561199886218120 minilyyy`" + HELP_HINT);
    return;
  }
  const name = args.slice(2).join(" ").trim() || steamid;
  const mod = store.add(steamid, name, 1);
  if (!mod) {
    await message.reply(`⚠️ SteamID \`${steamid}\` уже есть в списке.`);
    return;
  }
  patchStats();
  await autoPost();
  refresh();
  await message.reply(
    `✅ Добавлен **${mod.name}** (\`${steamid}\`) с рангом **1** (${store.rankTitle(1)}).\n` +
    "Сменить ранг: `!swap_rank " + steamid + " <1-5>`. Статистика обновится в течение минуты."
  );
}

// !swap_rank <SteamID64...> <ранг 1-4>
// Несколько SteamID сразу; кого нет в списке — добавятся автоматически.
async function cmdSwapRank(message, args) {
  const rank = Number(args[args.length - 1]);
  const steamids = args.slice(1, -1);
  if (!Number.isInteger(rank) || rank < 1 || rank > 5 || steamids.length === 0 || !steamids.every((s) => STEAMID_RE.test(s))) {
    await message.reply(
      "Формат: `!swap_rank <SteamID64...> <ранг>`\n" +
      "Ранги: **1** — мл. Модератор, **2** — Модератор, **3** — ст. Модератор, **4** — ст. Администратор, **5** — Стафф\n" +
      "Пример: `!swap_rank 76561199559786627 76561199566639200 2`" + HELP_HINT
    );
    return;
  }
  const title = store.rankTitle(rank) || `ранг ${rank}`;
  const assigned = [];
  const added = [];
  const skipped = [];
  for (const sid of steamids) {
    const existing = store.load().find((m) => m.steamid === sid);
    if (existing) {
      store.setRank(sid, rank);
      assigned.push(existing.name);
    } else {
      const mod = store.add(sid, sid, rank);
      if (mod) added.push(sid);
      else skipped.push(sid);
    }
    clearAnnounced(sid); // норма изменилась — объявление можно отправить заново
  }
  patchStats();
  await autoPost();
  refresh();

  let out = `✅ Ранг **${rank}** (${title}) назначен: **${assigned.join(", ") || "—"}**`;
  if (added.length) out += `\n➕ Добавлены в список с этим рангом: \`${added.join("`, `")}\``;
  if (skipped.length) out += `\n⚠️ Пропущены: \`${skipped.join("`, `")}\``;
  out += "\nСтатистика обновится в течение минуты.";
  await message.reply(out);
}

// !reload — 5 тщательных пересчётов, затем очистка канала и свежий пост
async function cmdReload(message) {
  if (thoroughRunning) {
    await message.reply("⏳ Пересчёт уже идёт, дождитесь окончания.");
    return;
  }
  thoroughRunning = true;
  try {
    await message.channel.send("Подсчет статистики");
    console.log("[бот] !reload: начат тщательный пересчёт (5 проходов)");
    stats = await buildStatsThorough(5);
    saveCache(stats);
    console.log(`[бот] !reload: пересчёт готов (${stats.totals.total} наказаний), очистка и публикация`);
    await notifySpecsubs();
    await clearChannels();
    await checkAnnouncements();
    await autoPost();
  } catch (e) {
    console.error("[бот] Ошибка !reload:", e);
    try {
      await message.channel.send("⚠️ Ошибка пересчёта: " + (e && e.message ? e.message : e));
    } catch { /* игнор */ }
  } finally {
    thoroughRunning = false;
  }
}

// !discord <SteamID64> <usernamediscord> — привязка Discord (в таблице не отображается)
async function cmdDiscord(message, args) {
  const steamid = args[1] || "";
  const discord = args.slice(2).join(" ").trim();
  if (!STEAMID_RE.test(steamid) || !discord) {
    await message.reply("Формат: `!discord <SteamID64> <usernamediscord>`\nПример: `!discord 76561199886218120 minilyyy`" + HELP_HINT);
    return;
  }
  if (!store.setDiscord(steamid, discord)) {
    await message.reply(`⚠️ SteamID \`${steamid}\` не найден в списке. Сначала добавьте: \`!mod_add ${steamid}\``);
    return;
  }
  const mod = store.load().find((m) => m.steamid === steamid);
  await message.reply(`✅ Discord привязан: **${mod.name}** (\`${steamid}\`) → \`${mod.discord}\``);
}

// !info <SteamID64> — SteamID, Discord, ссылка на профиль
async function cmdInfo(message, args) {
  const steamid = args[1] || "";
  if (!STEAMID_RE.test(steamid)) {
    await message.reply("Формат: `!info <SteamID64>`\nПример: `!info 76561199886218120`" + HELP_HINT);
    return;
  }
  const mod = store.load().find((m) => m.steamid === steamid);
  if (!mod) {
    await message.reply(`⚠️ SteamID \`${steamid}\` не найден в списке.`);
    return;
  }
  await message.reply(
    `**${mod.name}**\n` +
    `SteamID: \`${mod.steamid}\`\n` +
    `Discord: ${mod.discord ? "`" + mod.discord + "`" : "не привязан"}\n` +
    `Профиль: https://fearproject.ru/profile/${mod.steamid}`
  );
}

// !name <SteamID64> <НИК> — задать отображаемое имя в таблице
async function cmdName(message, args) {
  const steamid = args[1] || "";
  const name = args.slice(2).join(" ").trim();
  if (!STEAMID_RE.test(steamid) || !name) {
    await message.reply("Формат: `!name <SteamID64> <НИК>`\nПример: `!name 76561199886218120 minilyyy`" + HELP_HINT);
    return;
  }
  if (!store.setName(steamid, name)) {
    await message.reply(`⚠️ SteamID \`${steamid}\` не найден в списке. Сначала добавьте: \`!mod_add ${steamid}\``);
    return;
  }
  patchStats();
  await autoPost();
  await message.reply(`✅ Имя для \`${steamid}\` задано: **${name}**`);
}

// !clear — полностью очистить канал статистики и опубликовать её заново
async function cmdClear(message) {
  await clearChannels();
  await autoPost();
  await message.reply("✅ Канал очищен, статистика опубликована заново.");
}

// !discords — список привязок Discord у модераторов (— = не привязан)
async function cmdDiscords(message) {
  const mods = store.load();
  const lines = mods.map((m) => `**${m.name}** (\`${m.steamid}\`): ${m.discord ? "`" + m.discord + "`" : "—"}`);
  // режем на части до 3500 символов (лимит описания эмбеда — 4096)
  const embeds = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3500) {
      embeds.push(new EmbedBuilder().setColor(0x4d70ef).setDescription(chunk));
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) embeds.push(new EmbedBuilder().setColor(0x4d70ef).setDescription(chunk));
  embeds[0].setTitle(`🔗 Привязки Discord (${mods.length})`);
  await message.channel.send({ embeds: embeds.slice(0, 10) });
}

// ---------- Отслеживание статистики в ЛС (!specstats) ----------

// подписи счётчиков для определения изменений
function specSig(mod) {
  return [mod.bans, mod.mutes, mod.total, mod.removed, mod.excluded || 0, mod.weekTotal].join("/");
}

function buildSpecEmbed(mod, s) {
  const lines = [
    `🔨 Баны: **${mod.bans}**`,
    `🔕 Муты: **${mod.mutes}**`,
    `📌 Всего засчитано: **${mod.total}**`,
    `🔓 Снято вручную: **${mod.removed}**`
  ];
  if (mod.excluded) lines.push(`🚫 Исключено (тикет/поддержка): **${mod.excluded}**`);
  if (mod.norma) {
    const c = completion(mod);
    if (mod.norma.week > 0) lines.push(`📅 Неделя: **${mod.weekTotal}/${mod.norma.week}**`);
    if (mod.norma.month > 0 && c) lines.push(`📆 Месяц: **${mod.total}/${mod.norma.month}** — ${c.pct}%${c.done ? "✓" : ""}`);
  }
  return new EmbedBuilder()
    .setColor(0x4d70ef)
    .setTitle(`📊 ${mod.name}${store.rankTitle(mod.rank) ? ` (${store.rankTitle(mod.rank)})` : ""} — ${s.month}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Обновлено ${fmtTime.format(new Date(s.updatedAt * 1000))} МСК • fearproject.ru` });
}

async function sendSpecstat(userId, mod, s) {
  const user = await client.users.fetch(userId);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spec_last20_${userId}`).setLabel("Последние 20 наказаний").setStyle(ButtonStyle.Primary)
  );
  await user.send({ embeds: [buildSpecEmbed(mod, s)], components: [row] });
}

// рассылает подписчикам новую статистику, если она изменилась
async function notifySpecsubs() {
  if (!stats || !stats.weekStart) return;
  const state = loadState();
  state.specsubs = state.specsubs || {};
  let changed = false;
  for (const [userId, sub] of Object.entries(state.specsubs)) {
    const mod = stats.moderators.find((m) => m.steamid === sub.steamid);
    if (!mod) continue;
    const sig = specSig(mod);
    if (sig === sub.lastSig) continue;
    try {
      await sendSpecstat(userId, mod, stats);
      sub.lastSig = sig;
      changed = true;
    } catch (e) {
      console.error(`[бот] specstats → ${userId} недоступен (отписка):`, e && e.message ? e.message : e);
      delete state.specsubs[userId];
      changed = true;
    }
  }
  if (changed) saveState(state);
}

// Отправить текст пользователю в ЛС; если не вышло — ответить в канал
async function dmOrReply(message, text) {
  try {
    const u = await client.users.fetch(message.author.id);
    await u.send(text);
  } catch {
    await message.reply(text);
  }
}

// !specstats <SteamID64> — подписка на статистику модератора в ЛС (любой пользователь)
// !specstats off / !unspec — отписка
// Подтверждения уходят в ЛС, чтобы бот не писал в других каналах.
async function cmdSpecstats(message, args) {
  const state = loadState();
  state.specsubs = state.specsubs || {};
  const sub = state.specsubs[message.author.id];
  const arg = (args[1] || "").toLowerCase();

  if (!arg) {
    await dmOrReply(
      message,
      sub
        ? `Вы отслеживаете: \`${sub.steamid}\`\nСменить: \`!specstats <SteamID64>\` • Остановить: \`!unspec\``
        : "Формат: `!specstats <SteamID64>` — пришлю в ЛС статистику модератора и буду присылать новую при каждом изменении.\nОстановить: `!unspec`"
    );
    return;
  }
  if (arg === "off" || arg === "стоп" || arg === "stop" || arg === "unspec") {
    if (!sub) {
      await dmOrReply(message, "У вас нет активной подписки.");
      return;
    }
    delete state.specsubs[message.author.id];
    saveState(state);
    await dmOrReply(message, "✅ Отслеживание остановлено.");
    return;
  }
  const sid = args[1];
  if (!STEAMID_RE.test(sid)) {
    await message.reply("Формат: `!specstats <SteamID64>`" + HELP_HINT);
    return;
  }
  if (!store.load().some((m) => m.steamid === sid)) {
    await message.reply(`⚠️ SteamID \`${sid}\` не найден в списке модераторов.`);
    return;
  }
  const mod = stats && stats.moderators.find((m) => m.steamid === sid);
  try {
    if (mod) {
      await sendSpecstat(message.author.id, mod, stats);
      state.specsubs[message.author.id] = { steamid: sid, lastSig: specSig(mod) };
    } else {
      state.specsubs[message.author.id] = { steamid: sid, lastSig: null };
    }
    saveState(state);
    await dmOrReply(
      message,
      `✅ Подписка оформлена: буду присылать вам в ЛС статистику \`${sid}\` при каждом изменении.\n` +
      "Остановить: `!unspec` или `!specstats off`"
    );
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    console.error("[бот] specstats: не удалось отправить ЛС:", reason);
    await message.reply(
      "⚠️ Не удалось отправить ЛС: `" + reason.slice(0, 150) + "`\n" +
      "Проверьте: 1) ПКМ по иконке сервера → Настройки конфиденциальности → **Разрешить ЛС**; " +
      "2) глобально: Настройки → Конфиденциальность → ЛС от участников серверов; " +
      "3) бот не заблокирован у вас (ПКМ по боту → не должно быть «Разблокировать»)."
    );
  }
}

// !dmtest <userId> — диагностика доставки ЛС пользователю (владельцы)
async function cmdDmTest(message, args) {
  const uid = args[1] || "";
  if (!/^\d{17,20}$/.test(uid)) {
    await message.reply("Формат: `!dmtest <ID пользователя>`" + HELP_HINT);
    return;
  }
  try {
    const u = await client.users.fetch(uid);
    await u.send("🔍 Тестовое сообщение: проверка доставки ЛС от FearStats.");
    await message.reply(
      `✅ ЛС пользователю <@${uid}> **отправлено без ошибки**.\n` +
      "Если у получателя его не видно во входящих — оно во вкладке **«Запросы сообщений»** (ЛС → Запросы сообщений), нужно принять запрос один раз."
    );
  } catch (e) {
    await message.reply(`❌ Не удалось отправить <@${uid}>: \`${String(e && e.message ? e.message : e).slice(0, 200)}\``);
  }
}

// ---------- Слежение за онлайном и голосовыми каналами ----------

// Уведомление всем владельцам в ЛС
async function notifyOwners(text) {
  for (const oid of ownerIds) {
    try {
      const owner = await client.users.fetch(oid);
      await owner.send(text);
    } catch (e) {
      console.error(`[бот] ЛС владельцу ${oid}:`, e && e.message ? e.message : e);
    }
  }
}

const WATCH_STATUS = { online: "в сети", idle: "не активен", dnd: "не беспокоить" };
const lastOnlineNotify = new Map(); // userId -> ts последнего уведомления (анти-спам)
const ONLINE_NOTIFY_COOLDOWN = 10 * 60 * 1000;

// Появление отслеживаемого пользователя в сети (офлайн -> в сети/не беспокоить/не активен)
client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
  try {
    const uid = newPresence.userId;
    if (!watchUsers.includes(uid)) return;
    const was = oldPresence ? oldPresence.status : "offline";
    const now = newPresence.status;
    if (was !== "offline" || now === "offline") return; // только переход из офлайна
    const last = lastOnlineNotify.get(uid) || 0;
    if (Date.now() - last < ONLINE_NOTIFY_COOLDOWN) return;
    lastOnlineNotify.set(uid, Date.now());
    const tag = newPresence.user ? newPresence.user.tag : uid;
    console.log(`[бот] Онлайн: ${tag} (${now})`);
    await notifyOwners(`🟢 <@${uid}> (${tag}) появился в сети — статус: **${WATCH_STATUS[now] || now}**`);
  } catch (e) {
    console.error("[бот] PresenceUpdate:", e && e.message ? e.message : e);
  }
});

// Подключение отслеживаемого пользователя к голосовому каналу
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const uid = newState.id;
    if (!watchUsers.includes(uid)) return;
    if (oldState.channelId || !newState.channelId) return; // только подключение, не переход/выход
    const chName = newState.channel ? newState.channel.name : newState.channelId;
    const guildName = newState.guild ? newState.guild.name : "";
    const tag = newState.member && newState.member.user ? newState.member.user.tag : uid;
    console.log(`[бот] Голос: ${tag} -> ${chName}`);
    await notifyOwners(`🔊 <@${uid}> (${tag}) подключился к голосовому каналу **${chName}**${guildName ? ` на сервере ${guildName}` : ""}`);
  } catch (e) {
    console.error("[бот] VoiceStateUpdate:", e && e.message ? e.message : e);
  }
});

// ---------- Озвучка текста в голосовом канале (!say) ----------

let audioPlayer = null;
function getAudioPlayer() {
  if (!audioPlayer) {
    audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  }
  return audioPlayer;
}

// TTS (русский голос) -> MP3 -> AudioResource
async function ttsResource(text) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ru&client=tw-ob&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createAudioResource(Readable.from(buf), { inputType: StreamType.Arbitrary, inlineVolume: true });
}

// Произнести текст через существующее голосовое подключение
async function speakInConnection(connection, text) {
  const resource = await ttsResource(text);
  connection.subscribe(getAudioPlayer());
  getAudioPlayer().play(resource);
}

// Текущее голосовое подключение бота (null — бот не в войсе)
function findVoiceConnection() {
  for (const g of client.guilds.cache.values()) {
    const c = getVoiceConnection(g.id);
    if (c) return c;
  }
  return null;
}

// !say [ID канала] <текст> — бот произносит текст в голосовом канале (владельцы).
// Без ID — в канале, где бот уже сидит (!voice).
async function cmdSay(message, args) {
  let text = args.slice(1).join(" ").trim();
  let connection = null;

  if (/^\d{17,20}$/.test(args[1] || "")) {
    const ch = await client.channels.fetch(args[1]).catch(() => null);
    if (!ch || !ch.isVoiceBased()) {
      await message.reply(`❌ Канал \`${args[1]}\` не найден или не голосовой.`);
      return;
    }
    text = args.slice(2).join(" ").trim();
    try {
      connection = joinVoiceChannel({
        channelId: ch.id,
        guildId: ch.guild.id,
        adapterCreator: ch.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });
    } catch (e) {
      await message.reply(`❌ Не удалось подключиться к **${ch.name}**: \`${String(e && e.message ? e.message : e).slice(0, 150)}\``);
      return;
    }
  } else {
    for (const g of client.guilds.cache.values()) {
      const c = getVoiceConnection(g.id);
      if (c) {
        connection = c;
        break;
      }
    }
    if (!connection) {
      await message.reply("⚠️ Я не в голосовом канале. Сначала `!voice <ID канала>` или укажите канал: `!say <ID канала> <текст>`");
      return;
    }
  }

  if (!text) {
    await message.reply("Формат: `!say [ID канала] <текст>`\nПример: `!say Всем привет!`" + HELP_HINT);
    return;
  }
  if (text.length > 190) {
    await message.reply("⚠️ Текст длинный, произнесу первые 190 символов.");
    text = text.slice(0, 190);
  }

  try {
    await speakInConnection(connection, text);
    console.log(`[бот] say от ${message.author.tag}: "${text.slice(0, 60)}"`);
    await message.reply("🔊 Произношу…");
  } catch (e) {
    await message.reply(`❌ Не удалось озвучить: \`${String(e && e.message ? e.message : e).slice(0, 150)}\``);
  }
}

// ---------- Звуковые команды (!koza1/!koza2/!svin) ----------

const SOUND_COMMANDS = {
  "!koza1": "koza1.mp3",
  "!koza2": "koza2.mp3",
  "!svin": "svin.mp3"
};
const SOUND_DIR = path.join(__dirname, "sounds");

async function cmdSound(message, fileName) {
  const conn = findVoiceConnection();
  if (!conn) {
    await message.reply("⚠️ Бот не в голосовом канале. Сначала `!voice <ID канала>`.");
    return;
  }
  const file = path.join(SOUND_DIR, fileName);
  if (!fs.existsSync(file)) {
    await message.reply(`❌ Файл \`${fileName}\` не найден.`);
    return;
  }
  try {
    const res = createAudioResource(fs.createReadStream(file), { inputType: StreamType.Arbitrary, inlineVolume: true });
    conn.subscribe(getAudioPlayer());
    getAudioPlayer().play(res);
    console.log(`[бот] sound ${fileName} от ${message.author.tag}`);
  } catch (e) {
    await message.reply(`❌ Не удалось воспроизвести: \`${String(e && e.message ? e.message : e).slice(0, 150)}\``);
  }
}

// ---------- Вход бота в голосовой канал (!voice) ----------

// !voice <ChannelID> — зайти в голосовой канал и сидеть там, пока не кикнут
// !voice off — выйти из голосового канала
async function cmdVoice(message, args) {
  const arg = (args[1] || "").toLowerCase();

  if (arg === "off" || arg === "стоп" || arg === "stop") {
    let left = 0;
    for (const guild of client.guilds.cache.values()) {
      const conn = getVoiceConnection(guild.id);
      if (conn) {
        conn.destroy();
        left++;
      }
    }
    await message.reply(left ? "✅ Вышел из голосового канала." : "Я и так не в голосовом канале.");
    return;
  }

  const cid = args[1] || "";
  if (!/^\d{17,20}$/.test(cid)) {
    await message.reply("Формат: `!voice <ID голосового канала>` — зайти и сидеть, `!voice off` — выйти." + HELP_HINT);
    return;
  }

  let ch;
  try {
    ch = await client.channels.fetch(cid);
  } catch {
    ch = null;
  }
  if (!ch || !ch.isVoiceBased()) {
    await message.reply(`❌ Канал \`${cid}\` не найден или не голосовой.`);
    return;
  }
  const me = ch.guild.members.me;
  const perms = me ? ch.permissionsFor(me) : null;
  if (perms && (!perms.has("Connect") || !perms.has("ViewChannel"))) {
    await message.reply(`❌ У бота нет прав на подключение к **${ch.name}**.`);
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: ch.id,
      guildId: ch.guild.id,
      adapterCreator: ch.guild.voiceAdapterCreator,
      selfDeaf: true, // сидеть с выключенным звуком
      selfMute: true
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.log(`[бот] voice: разрыв соединения с ${ch.name}, переподключение...`);
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log(`[бот] voice: соединение с ${ch.name} уничтожено (кик или !voice off)`);
    });
    console.log(`[бот] voice: вхожу в ${ch.name} (${ch.guild.name}) по команде ${message.author.tag}`);
    await message.reply(`✅ Захожу в голосовой канал **${ch.name}** (сервер: ${ch.guild.name}). Сижу, пока не кикнут. Выйти: \`!voice off\``);
  } catch (e) {
    await message.reply(`❌ Не удалось подключиться: \`${String(e && e.message ? e.message : e).slice(0, 200)}\``);
  }
}

// ---------- Подозрение в читах: новички < 2ч с K/D > 2 ----------

function playtimeLabel(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

async function checkSuspects() {
  if (!suspectChannelId) return;
  let found;
  try {
    found = await findSuspects(); // playtime < 2ч и K/D > 2
  } catch (e) {
    console.error("[бот] suspect: ошибка сканирования:", e && e.message ? e.message : e);
    return;
  }
  if (!found.length) return;

  const state = loadState();
  state.suspects = state.suspects || {};
  let ch;
  try {
    ch = await client.channels.fetch(suspectChannelId);
  } catch (e) {
    console.error(`[бот] suspect: канал ${suspectChannelId} недоступен:`, e && e.message ? e.message : e);
    return;
  }
  if (!ch || !ch.isTextBased()) return;

  let reported = 0;
  for (const p of found) {
    if (state.suspects[p.steamid]) continue; // уже сообщали
    const emb = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("🚨 Подозрение в читах")
      .setDescription(
        `Игрок **${p.name}** подозрителен: мало времени на проекте при высоком K/D.\n\n` +
        `**K/D:** ${p.kd} (${p.kills}/${p.deaths})\n` +
        `**Время на проекте:** ${playtimeLabel(p.playtime)}\n` +
        `**SteamID:** \`${p.steamid}\`\n` +
        `**Профиль:** https://fearproject.ru/profile/${p.steamid}`
      )
      .setFooter({ text: `Позиция в лидерборде: ${p.position}` });
    try {
      await ch.send({ embeds: [emb] });
      state.suspects[p.steamid] = Date.now();
      reported++;
      console.log(`[бот] suspect: ${p.name} (K/D ${p.kd}, ${playtimeLabel(p.playtime)})`);
      await sleep(400);
    } catch (e) {
      console.error(`[бот] suspect: ошибка отправки о ${p.steamid}:`, e && e.message ? e.message : e);
    }
  }
  if (reported) saveState(state);
}

// ---------- !zav — ежедневная проверка состояния владельцев ----------

const ZAV_TEXT =
  "Приветствую. Вынужден сообщить вам печальную новость. Увы Никиты не стало, данное сообщение не отправлено им лично, он встраивал систему Мертвой руки. Никита не отвечал на запрос о своем состоянии более 72ч, что он лично посчитал не допустимым для нормального отсутствия. Далее его слова - Друзья, если бот всё таки отправил данное сообщение и вы вынуждены его читать, пожалуйста извините. Раз я решился на такое, значит окружение просто задавило меня, а я не был способен вынести всё это давление. Мне очень жаль что я так бездарно оставил вас, даже не сказав вам то, что мог не успеть когда еще была возможность, а раз я этого не смог при жизни, то сейчас это уже не важно, хотел бы сказать вам всем спасибо за то, что проводили со мной время и общались со мной, я ценил каждый момент с вами. Лёша, спасибо тебе за поддержку, без тебя я бы не стал Ст.Модером. Спасибо Артем за твой позитив, особенно за все откаты с твоими криками, оговорками и прочим, я посмелся от души. Так же отдельное и огромное спасибо Владе. Влада, спасибо тебе большое за твою доброту и дружелюбие, спасибо что волновалась за меня, хоть и не показывала этого, спасибо за поддержку которую ты мне оказывала, я правда всё это ценил. Спасибо вам всем за то что проводили со мной время, общались и поддерживали. Жаль что со мной так вышло, мне правда очень жаль, извините меня пожалуйста, не хотел я чтобы так вышло";

const ZAV_LIMIT = 72 * 3600 * 1000; // 72 часа без подтверждения

// кому приходит ежедневный вопрос о состоянии (один аккаунт)
const zavUserId = String(config.zavUser || ownerIds[0] || "");

// ближайшие 6:00 МСК
function nextSixAmMsk() {
  const nowMsk = new Date(Date.now() + MSK_MS);
  let target = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate(), 6, 0, 0) - MSK_MS;
  if (target <= Date.now()) target += 86400 * 1000;
  return target;
}

function scheduleZavDaily() {
  setTimeout(async () => {
    await sendZavDaily();
    scheduleZavDaily();
  }, nextSixAmMsk() - Date.now());
}

// ежедневный вопрос о состоянии в 6:00 МСК — на аккаунт, с которого включили !zav
async function sendZavDaily() {
  const state = loadState();
  if (!state.zav || !state.zav.enabled || state.zav.fired) return;
  const targetId = state.zav.userId || zavUserId;
  if (!targetId) return;
  try {
    const user = await client.users.fetch(targetId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("zav_ok").setLabel("Всё хорошо").setStyle(ButtonStyle.Success)
    );
    await user.send({ content: "Как вы себя чувствуете?", components: [row] });
    console.log(`[бот] zav: вопрос отправлен ${targetId}`);
  } catch (e) {
    console.error(`[бот] zav: ЛС ${targetId}:`, e && e.message ? e.message : e);
  }
}

// проверка 72ч тишины (раз в минуту)
async function checkZav() {
  const state = loadState();
  if (!state.zav || !state.zav.enabled || state.zav.fired) return;
  // таймер общий: подтверждение с ЛЮБОГО аккаунта владельца сбрасывает его
  if (Date.now() - (state.zav.lastConfirm || 0) < ZAV_LIMIT) return;
  state.zav.fired = true;
  state.zav.enabled = false;
  saveState(state);
  try {
    const ch = await client.channels.fetch(requestChannelId);
    await ch.send("@everyone\n" + ZAV_TEXT);
    console.log("[бот] zav: финальное сообщение отправлено в канал запросов");
  } catch (e) {
    console.error("[бот] zav: ошибка отправки финального сообщения:", e && e.message ? e.message : e);
  }
}

// подтверждение состояния (кнопка или текст "всё хорошо") — сбрасывает ОБЩИЙ таймер
async function confirmZav() {
  const state = loadState();
  if (!state.zav) return false;
  state.zav.lastConfirm = Date.now();
  saveState(state);
  return true;
}

// !zav — включить систему (в ЛС владельца), !zav off — выключить.
// Вопросы приходят на аккаунт, с которого систему активировали.
async function cmdZav(message) {
  const state = loadState();
  state.zav = state.zav || { enabled: false, fired: false, lastConfirm: 0, userId: null };
  const arg = (message.content.trim().split(/\s+/)[1] || "").toLowerCase();

  // система уже активна — разрешено управлять только с аккаунта-активатора
  if (state.zav.enabled && state.zav.userId && message.author.id !== state.zav.userId) {
    await message.channel.send(
      `⚠️ Система !zav уже запущена с аккаунта <@${state.zav.userId}>.\n` +
      "Сначала отключите её **с того аккаунта**: `!zav off`, затем включайте здесь."
    );
    return;
  }

  if (arg === "off" || arg === "стоп" || arg === "stop") {
    if (!state.zav.enabled) {
      await message.channel.send("Система !zav и так выключена.");
      return;
    }
    state.zav.enabled = false;
    state.zav.userId = null;
    saveState(state);
    await message.channel.send("⏹ Система !zav остановлена.");
    return;
  }

  if (state.zav.enabled) {
    await message.channel.send("Система уже активна на этом аккаунте: ежедневный вопрос в 6:00 МСК, лимит подтверждения — 72 часа. Остановить: `!zav off`");
    return;
  }

  state.zav.enabled = true;
  state.zav.fired = false;
  state.zav.lastConfirm = Date.now();
  state.zav.userId = message.author.id; // вопросы будут приходить на этот аккаунт
  saveState(state);
  console.log(`[бот] zav: активировано владельцем ${message.author.tag} (${message.author.id})`);
  await message.channel.send(
    "✅ Система активирована с этого аккаунта.\nКаждый день в **6:00 МСК** сюда будет приходить «Как вы себя чувствуете?» с кнопкой «Всё хорошо».\n" +
    "72 часа без подтверждения (кнопкой или текстом «всё хорошо») — финальное сообщение в канал запросов.\n" +
    "Первое сообщение — прямо сейчас. Остановить: `!zav off`"
  );
  await sendZavDaily();
}

// ---------- Проверка config.vdf (!vdf) ----------

const pendingVdf = new Map(); // userId -> timestamp запроса файла
const VDF_WAIT_MS = 10 * 60 * 1000; // ждём файл 10 минут

// !vdf — только в канале запросов, любой пользователь.
// Бот просит config.vdf в ЛС, после получения анализирует аккаунты.
async function cmdVdf(message) {
  if (requestChannelId && message.channel.id !== requestChannelId) return; // молчим вне канала
  const startedAt = Date.now();
  pendingVdf.set(message.author.id, startedAt);
  setTimeout(() => {
    if (pendingVdf.get(message.author.id) === startedAt) pendingVdf.delete(message.author.id);
  }, VDF_WAIT_MS);
  try {
    const u = await client.users.fetch(message.author.id);
    await u.send(
      "📄 Пришлите файл **config.vdf** — прикрепите его следующим сообщением здесь, в ЛС (или вставьте содержимое текстом).\n" +
      "Я проверю все SteamID из раздела \"Accounts\" на активные баны fearproject.ru. Ожидание — 10 минут."
    );
    await message.reply("📩 Проверьте ЛС — жду файл config.vdf");
  } catch (e) {
    pendingVdf.delete(message.author.id);
    console.error("[бот] !vdf: не удалось отправить ЛС:", e && e.message ? e.message : e);
    await message.reply("⚠️ Не удалось отправить ЛС — включите их для этого сервера (ПКМ по серверу → Настройки конфиденциальности → Разрешить ЛС).");
  }
}

const MSK_MS = 3 * 3600 * 1000;
const fmtWhen = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

// Парсит "ДД.ММ.ГГГГ" и опционально "ЧЧ:ММ" в КОНЦЕ текста. Возвращает { text, sendAt } (sendAt — unix ms или null).
function parseSchedule(text) {
  let m = text.match(/\s(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    return {
      text: text.slice(0, m.index).trim(),
      sendAt: Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])) - MSK_MS
    };
  }
  m = text.match(/\s(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) {
    return {
      text: text.slice(0, m.index).trim(),
      sendAt: Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 0, 0) - MSK_MS // без времени — 00:00 МСК
    };
  }
  return { text, sendAt: null };
}

// Поиск пользователя по юзернейму среди всех серверов, где есть бот
async function findUserByName(name) {
  const q = name.toLowerCase();
  for (const guild of client.guilds.cache.values()) {
    try {
      const found = await guild.members.search({ query: name, limit: 5 });
      const exact =
        found.find((mb) => mb.user.username.toLowerCase() === q) ||
        found.find((mb) => (mb.nickname || "").toLowerCase() === q) ||
        found.find((mb) => (mb.displayName || "").toLowerCase() === q) ||
        found.first();
      if (exact) return exact.user;
    } catch (e) {
      console.error(`[бот] Поиск '${name}' на ${guild.name}:`, e && e.message ? e.message : e);
    }
  }
  return null;
}

// !msg <DiscordID|юзернейм> <текст> [ДД.ММ.ГГГГ [ЧЧ:ММ]] — ЛС пользователю от имени бота (только в ЛС владельца).
// Без даты — сразу; с датой — отложенно по МСК (без времени — в 00:00), с кнопкой отмены.
async function cmdMessage(message) {
  const m = message.content.trim().match(/^!msg\s+(\S+)\s+([\s\S]+)$/i);
  if (!m) {
    await message.channel.send(
      "Формат: `!msg <DiscordID или юзернейм> <текст> [ДД.ММ.ГГГГ [ЧЧ:ММ]]`\n" +
      "Примеры:\n`!msg 652399540384694292 Привет!` — сразу\n" +
      "`!msg minilyyy Привет! 05.08.2026 15:00` — в указанное время (МСК)\n" +
      "`!msg minilyyy Привет! 05.08.2026` — в 00:00 указанной даты"
    );
    return;
  }
  const token = m[1];
  const { text, sendAt } = parseSchedule(m[2]);
  if (!text) {
    await message.channel.send("⚠️ Пустой текст сообщения.");
    return;
  }

  let user = null;
  if (/^\d{17,20}$/.test(token)) {
    try {
      user = await client.users.fetch(token);
    } catch {
      user = null;
    }
  } else {
    await message.channel.send(`🔍 Ищу \`${token}\` по серверам…`);
    user = await findUserByName(token);
  }
  if (!user) {
    await message.channel.send(
      /^\d{17,20}$/.test(token)
        ? `❌ Пользователь с ID \`${token}\` не найден.`
        : `❌ Пользователь «${token}» не найден ни на одном сервере с ботом. Попробуйте указать ID.`
    );
    return;
  }

  await scheduleOrSend({ message, targetType: "user", targetId: user.id, targetLabel: `<@${user.id}> (${user.tag})`, text, sendAt });
}

// Разрешить цель упоминания: ID пользователя / юзернейм (по серверу канала) / everyone
async function resolveMention(token, guild) {
  const t = token.trim();
  if (!t) return null;
  if (t.toLowerCase() === "everyone") return { mention: "@everyone" };
  if (/^\d{17,20}$/.test(t)) {
    try {
      await client.users.fetch(t);
      return { mention: `<@${t}>` };
    } catch {
      return { error: `пользователь с ID \`${t}\` не найден` };
    }
  }
  if (guild) {
    try {
      const found = await guild.members.search({ query: t, limit: 5 });
      const exact =
        found.find((mb) => mb.user.username.toLowerCase() === t.toLowerCase()) ||
        found.find((mb) => (mb.nickname || "").toLowerCase() === t.toLowerCase()) ||
        found.first();
      if (exact) return { mention: `<@${exact.id}>` };
    } catch (e) {
      console.error("[бот] members.search:", e && e.message ? e.message : e);
    }
  }
  return { error: `пользователь «${t}» не найден на сервере` };
}

// !msgall <каналID> (<цель...>) <текст> [ДД.ММ.ГГГГ [ЧЧ:ММ]]
// Цель: ID пользователя, юзернейм или everyone; целей может быть несколько.
// Отправляет текст в канал с упоминаниями (только в ЛС владельца).
async function cmdMsgall(message) {
  const m = message.content.trim().match(/^!msgall\s+(\d{17,20})\s+\(([^)]*)\)\s+([\s\S]+)$/i);
  if (!m) {
    await message.channel.send(
      "Формат: `!msgall <ID канала> (<цель>) <текст> [ДД.ММ.ГГГГ [ЧЧ:ММ]]`\n" +
      "Цель — ID пользователя, юзернейм или `everyone`; несколько целей — через пробел/запятую.\n" +
      "Примеры:\n`!msgall 1530965306124668959 (1409222587673874555) Привет`\n" +
      "`!msgall 1533787013407576179 (everyone) ТЕКСТ`\n" +
      "`!msgall 1533787013407576179 (minilyyy cody) ТЕКСТ`"
    );
    return;
  }
  const cid = m[1];
  const targetTokens = m[2].split(/[\s,]+/).filter(Boolean);
  const { text, sendAt } = parseSchedule(m[3]);
  if (!text) {
    await message.channel.send("⚠️ Пустой текст сообщения.");
    return;
  }

  // проверка канала и прав
  let channel;
  try {
    channel = await client.channels.fetch(cid);
  } catch {
    channel = null;
  }
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await message.channel.send(`❌ Канал \`${cid}\` не найден или не текстовый.`);
    return;
  }
  const me = channel.guild ? channel.guild.members.me : null;
  const perms = me ? channel.permissionsFor(me) : null;
  if (perms && !perms.has("SendMessages")) {
    await message.channel.send(`❌ У бота нет прав писать в <#${cid}>.`);
    return;
  }

  // разрешаем цели
  const mentions = [];
  const errors = [];
  for (const token of targetTokens) {
    const r = await resolveMention(token, channel.guild);
    if (!r) continue;
    if (r.error) errors.push(r.error);
    else mentions.push(r.mention);
  }
  if (errors.length) {
    await message.channel.send("❌ Не удалось разрешить цели:\n• " + errors.join("\n• "));
    return;
  }
  if (!mentions.length) {
    await message.channel.send("⚠️ Не указано ни одной цели в скобках.");
    return;
  }
  if (mentions.includes("@everyone") && perms && !perms.has("MentionEveryone")) {
    await message.channel.send("❌ У бота нет права «Упоминать everyone» в этом канале.");
    return;
  }

  const finalText = `${mentions.join(" ")} ${text}`;
  if (finalText.length > 2000) {
    await message.channel.send(`⚠️ Сообщение слишком длинное (${finalText.length}/2000 символов).`);
    return;
  }

  await scheduleOrSend({ message, targetType: "channel", targetId: cid, targetLabel: `<#${cid}>`, text: finalText, sendAt });
}

// Склонение слова "наказание"
function pluralPunish(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "наказание";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "наказания";
  return "наказаний";
}

// Родительный падеж должностей для текста предупреждения
const RANK_GENITIVE = {
  1: "Младшего Модератора",
  2: "Модератора",
  3: "Старшего Модератора",
  4: "Старшего Администратора",
  5: "Стаффа"
};

// !warnnorma <DiscordID> [неделя/месяц рангID] — предупреждение о невыполнении нормы (только в ЛС владельца).
// Без параметров нормы — берётся текущая норма ранга 1 (Мл. Модератор).
async function cmdWarnNorma(message) {
  const m = message.content.trim().match(/^!warnnorma\s+(\d{17,20})(?:\s+(\d+)\s*\/\s*(\d+)\s+([1-5]))?$/i);
  if (!m) {
    await message.channel.send(
      "Формат: `!warnnorma <DiscordID> [неделя/месяц рангID]`\n" +
      "Примеры:\n`!warnnorma 1409222587673874555` — норма Мл. Модератора (20/100)\n" +
      "`!warnnorma 1409222587673874555 30/130 2` — своя норма 30/130, ранг Модератор\n" +
      "Ранги: 1 — Мл. Модератор, 2 — Модератор, 3 — Ст. Модератор, 4 — Ст. Администратор, 5 — Стафф"
    );
    return;
  }
  const uid = m[1];

  let week, month, rankId;
  if (m[4]) {
    week = Number(m[2]);
    month = Number(m[3]);
    rankId = Number(m[4]);
  } else {
    const r1 = store.loadRanks().find((r) => r.rank === 1);
    week = r1 ? r1.week : 20;
    month = r1 ? r1.month : 100;
    rankId = 1;
  }
  const rankGen = RANK_GENITIVE[rankId] || RANK_GENITIVE[1];

  let normaPhrase;
  if (week > 0 && month > 0) {
    normaPhrase = `еженедельная норма составляет ${week} ${pluralPunish(week)}, а ежемесячная ${month} ${pluralPunish(month)}`;
  } else if (month > 0) {
    normaPhrase = `ежемесячная норма составляет ${month} ${pluralPunish(month)}`;
  } else {
    normaPhrase = `еженедельная норма составляет ${week} ${pluralPunish(week)}`;
  }

  const text =
    "Приветствую. Сообщаю вам, что вы долгое время не проявляете активность на проекте. " +
    `Напоминаю, для ${rankGen} ${normaPhrase}. ` +
    "Поторопитесь выполнить её, иначе не выполнение нормы под конец месяца повлечет за собой снятие с должности " +
    `${rankGen}.`;

  try {
    const u = await client.users.fetch(uid);
    await u.send(text);
    await message.channel.send(`✅ Предупреждение отправлено <@${uid}> (${u.tag}):\n> ${text}`);
    console.log(`[бот] !warnnorma от ${message.author.tag} -> ${uid} (${rankId}, ${week}/${month})`);
  } catch (e) {
    await message.channel.send(`❌ Не удалось отправить <@${uid}>: \`${String(e && e.message ? e.message : e).slice(0, 200)}\``);
  }
}

// !msgc <каналID> <текст> [ДД.ММ.ГГГГ [ЧЧ:ММ]] — сообщение от бота в указанный канал (только в ЛС владельца)
async function cmdMessagec(message) {
  const m = message.content.trim().match(/^!msgc\s+(\d{17,20})\s+([\s\S]+)$/i);
  if (!m) {
    await message.channel.send(
      "Формат: `!msgc <ID канала> <текст> [ДД.ММ.ГГГГ [ЧЧ:ММ]]`\n" +
      "Примеры:\n`!msgc 1533787013407576179 Всем привет!` — сразу\n" +
      "`!msgc 1533787013407576179 Анонс 05.08.2026 15:00` — в указанное время (МСК)"
    );
    return;
  }
  const cid = m[1];
  const { text, sendAt } = parseSchedule(m[2]);
  if (!text) {
    await message.channel.send("⚠️ Пустой текст сообщения.");
    return;
  }

  // проверка канала и прав заранее
  let channel;
  try {
    channel = await client.channels.fetch(cid);
  } catch {
    channel = null;
  }
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await message.channel.send(`❌ Канал \`${cid}\` не найден или не текстовый.`);
    return;
  }
  const me = channel.guild ? channel.guild.members.me : null;
  const perms = me ? channel.permissionsFor(me) : null;
  if (perms && !perms.has("SendMessages")) {
    await message.channel.send(`❌ У бота нет прав писать в <#${cid}>.`);
    return;
  }

  await scheduleOrSend({ message, targetType: "channel", targetId: cid, targetLabel: `<#${cid}>`, text, sendAt, footerName: message.author.username });
}

function jobTargetLabel(job) {
  return job.targetType === "channel" ? `<#${job.targetId}>` : `<@${job.targetId}>`;
}

// Отправка отложенных сообщений по таймеру (переживает перезапуск через state.json)
async function processScheduledMsgs() {
  const state = loadState();
  const jobs = Object.values(state.scheduledMsgs || {});
  if (!jobs.length) return;
  let changed = false;
  for (const job of jobs) {
    if (job.sendAt > Date.now()) continue;
    delete state.scheduledMsgs[job.id];
    changed = true;
    try {
      if (job.targetType === "channel") {
        const ch = await client.channels.fetch(job.targetId);
        await ch.send(userMsgPayload(job.text, job.footerName));
      } else {
        const u = await client.users.fetch(job.targetId);
        await u.send(userMsgPayload(job.text, null)); // !msg — обычный текст без эмбеда
      }
      console.log(`[бот] Отложенное сообщение ${job.id} доставлено -> ${job.targetId}`);
      try {
        const owner = await client.users.fetch(job.byId);
        await owner.send(`✅ Запланированное сообщение отправлено ${jobTargetLabel(job)}:\n> ${job.text}`);
      } catch { /* подтверждение не критично */ }
    } catch (e) {
      console.error(`[бот] Отложенное сообщение ${job.id} не доставлено:`, e && e.message ? e.message : e);
      try {
        const owner = await client.users.fetch(job.byId);
        await owner.send(`❌ Не удалось отправить запланированное сообщение ${jobTargetLabel(job)}:\n> ${job.text}\nПричина: \`${String(e && e.message ? e.message : e).slice(0, 150)}\``);
      } catch { /* игнор */ }
    }
  }
  if (changed) saveState(state);
}

// Сообщение пользователю: если задан footerName — эмбед с подписью отправителя внизу
function userMsgPayload(text, footerName) {
  if (!footerName) return { content: text };
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x4d70ef)
        .setDescription(text)
        .setFooter({ text: footerName })
    ]
  };
}

// Планирование/отправка в канал или пользователю (общая часть !msg / !msgc)
async function scheduleOrSend({ message, targetType, targetId, targetLabel, text, sendAt, footerName }) {
  // мгновенная отправка
  if (!sendAt) {
    try {
      if (targetType === "channel") {
        const ch = await client.channels.fetch(targetId);
        await ch.send(userMsgPayload(text, footerName));
      } else {
        const u = await client.users.fetch(targetId);
        await u.send(userMsgPayload(text, null)); // !msg — обычный текст без эмбеда
      }
      await message.channel.send(`✅ Сообщение отправлено ${targetLabel}.`);
      console.log(`[бот] !msg${targetType === "channel" ? "c" : ""} от ${message.author.tag} -> ${targetId}`);
    } catch (e) {
      await message.channel.send(`❌ Не удалось отправить ${targetLabel}: \`${String(e && e.message ? e.message : e).slice(0, 200)}\``);
    }
    return;
  }

  // отложенная отправка
  if (sendAt <= Date.now()) {
    await message.channel.send("⚠️ Указанное время уже в прошлом (МСК). Сообщение не запланировано.");
    return;
  }
  const state = loadState();
  state.scheduledMsgs = state.scheduledMsgs || {};
  const id = crypto.randomBytes(4).toString("hex");
  state.scheduledMsgs[id] = { id, byId: message.author.id, targetType, targetId, text, sendAt, footerName: footerName || null };
  saveState(state);
  console.log(`[бот] !msg отложено ${id} -> ${targetId} на ${fmtWhen.format(new Date(sendAt))} МСК`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`msg_cancel_${id}`).setLabel("Отменить отправку").setStyle(ButtonStyle.Danger)
  );
  await message.channel.send({
    content: `⏰ Сообщение для ${targetLabel} запланировано на **${fmtWhen.format(new Date(sendAt))} МСК**:\n> ${text}`,
    components: [row]
  });
}

// Приём config.vdf и команд владельца в ЛС
async function handleDm(message) {
  // команды владельца в ЛС
  if (ownerIds.includes(message.author.id)) {
    const dmText = message.content.trim().toLowerCase();

    // подтверждение состояния текстом (!zav)
    if (dmText === "всё хорошо") {
      const state = loadState();
      if (state.zav && state.zav.enabled) {
        await confirmZav(message.author.id);
        console.log(`[бот] zav: подтверждение текстом от ${message.author.tag}`);
        await message.channel.send("✅ Принято! Таймер сброшен.");
      }
      return;
    }

    const firstWord = message.content.trim().split(/\s+/)[0].toLowerCase();
    if (firstWord === "!zav") {
      return await cmdZav(message);
    }
    if (firstWord === "!msg") {
      return await cmdMessage(message);
    }
    if (firstWord === "!msgc") {
      return await cmdMessagec(message);
    }
    if (firstWord === "!msgall") {
      return await cmdMsgall(message);
    }
    if (firstWord === "!warnnorma") {
      return await cmdWarnNorma(message);
    }
    if (firstWord === "!voice") {
      return await cmdVoice(message, message.content.trim().split(/\s+/));
    }
    if (firstWord === "!say") {
      return await cmdSay(message, message.content.trim().split(/\s+/));
    }
    if (firstWord === "!help" || firstWord === "!помощь") {
      return await message.channel.send(DM_HELP_TEXT);
    }
  } else if (bolotniyUsers.includes(message.author.id)) {
    // разрешённым пользователям доступны !msgc и !say в ЛС с ботом
    const firstWord = message.content.trim().split(/\s+/)[0].toLowerCase();
    if (firstWord === "!msgc") {
      return await cmdMessagec(message);
    }
    if (firstWord === "!say") {
      return await cmdSay(message, message.content.trim().split(/\s+/));
    }
  }

  const startedAt = pendingVdf.get(message.author.id);
  if (!startedAt) return; // мы его файл не ждали — молчим
  if (Date.now() - startedAt > VDF_WAIT_MS) {
    pendingVdf.delete(message.author.id);
    await message.channel.send("⏱ Время вышло. Запустите заново командой `!vdf` в канале запросов.");
    return;
  }

  let text = null;
  const att =
    [...message.attachments.values()].find((a) => /config\.vdf$|\.vdf$|\.txt$/i.test(a.name || "")) ||
    message.attachments.first();
  if (att && (att.size || 0) < 2 * 1024 * 1024) {
    try {
      const r = await fetch(att.url);
      text = await r.text();
    } catch { /* пустим дальше по тексту сообщения */ }
  }
  if (!text && message.content.includes("SteamID")) text = message.content;

  if (!text) {
    await message.channel.send("⚠️ Файл не найден. Прикрепите **config.vdf** файлом (или пришлите его содержимое текстом).");
    return;
  }

  pendingVdf.delete(message.author.id);
  await message.channel.send("🔍 Файл получен, анализирую аккаунты…");
  try {
    const report = await analyzeVdf(text);
    await message.channel.send(report);
  } catch (e) {
    console.error("[бот] !vdf: ошибка анализа:", e);
    await message.channel.send("⚠️ Ошибка анализа: " + (e && e.message ? e.message : e));
  }
}

// !norma — показать нормы рангов
// !norma <ранг 1-4> <неделя>/<месяц>  — изменить норму ранга ("-" вместо числа — нормы нет)
async function cmdNorma(message, args) {
  const ranks = store.loadRanks();
  if (args.length === 1) {
    const lines = ranks.map((r) => {
      const parts = [];
      if (r.week > 0) parts.push(`${r.week}/нед`);
      if (r.month > 0) parts.push(`${r.month}/мес`);
      return `**${r.rank}.** ${r.title} — ${parts.join(", ") || "норма не задана"}`;
    });
    await message.reply(
      "**Нормы по рангам (наказания):**\n" + lines.join("\n") + "\n\n" +
      "Изменить: `!norma <ранг> <неделя>/<месяц>` — например `!norma 1 20/100`, `!norma 3 -/50`\n" +
      "Назначить ранг: `!swap_rank <SteamID...> <ранг>`"
    );
    return;
  }

  const match = args.slice(1).join(" ").match(/^([1-5])\s*(\d+|-)\s*\/\s*(\d+|-)$/);
  if (!match) {
    await message.reply("Формат: `!norma <ранг> <неделя>/<месяц>`\nПример: `!norma 1 20/100` или `!norma 3 -/50` (прочерк — нормы нет)" + HELP_HINT);
    return;
  }
  const rank = Number(match[1]);
  const week = match[2] === "-" ? 0 : Number(match[2]);
  const month = match[3] === "-" ? 0 : Number(match[3]);
  if (week <= 0 && month <= 0) {
    await message.reply("⚠️ Хотя бы одна норма (неделя или месяц) должна быть больше нуля.");
    return;
  }
  const r = store.setRankNorm(rank, week, month);
  if (!r) {
    await message.reply(`⚠️ Ранг ${rank} не найден.`);
    return;
  }
  // норма ранга изменилась — объявления для всех с этим рангом можно отправить заново
  for (const m of store.load().filter((x) => x.rank === rank)) clearAnnounced(m.steamid);
  patchStats();
  await autoPost();
  const parts = [];
  if (r.week > 0) parts.push(`**${r.week}/нед**`);
  if (r.month > 0) parts.push(`**${r.month}/мес**`);
  await message.reply(`✅ Норма ранга **${r.rank}** (${r.title}): ${parts.join(", ")}`);
}

// !mod_del <SteamID64>
async function cmdModDel(message, args) {
  const steamid = args[1] || "";
  if (!STEAMID_RE.test(steamid)) {
    await message.reply("Формат: `!mod_del <SteamID64>`" + HELP_HINT);
    return;
  }
  if (!store.remove(steamid)) {
    await message.reply(`⚠️ SteamID \`${steamid}\` не найден в списке.`);
    return;
  }
  patchStats();
  await autoPost();
  refresh();
  await message.reply(`✅ Пользователь \`${steamid}\` убран из отслеживания.`);
}

// !m <команда> — запрос на выполнение команды от любого пользователя в любом канале.
// Владельцу уходит ЛС с кнопками "Принять"/"Отклонить".
async function handleMentionCommand(message) {
  let command = message.content.trim().replace(/^!m(\s+|$)/i, "").trim();
  if (!command) {
    await message.reply("Формат: `!m <команда>`\nПример: `!m !reload`");
    return;
  }
  if (!command.startsWith("!")) command = "!" + command; // можно писать !m reload
  if (/^!m(\s+|$)/i.test(command)) {
    await message.reply("Нельзя запросить саму `!m` 🙂");
    return;
  }

  // автоодобрение для доверенных пользователей — без ЛС и кнопок
  if (autoApprove.includes(message.author.id)) {
    await executeApproved({ userId: message.author.id, userTag: message.author.tag, command });
    return;
  }

  const id = String(requestSeq++);
  const req = {
    userId: message.author.id,
    userTag: message.author.tag,
    command,
    createdAt: Date.now(),
    dmMessages: []
  };
  pendingRequests.set(id, req);
  setTimeout(() => pendingRequests.delete(id), 30 * 60 * 1000); // запрос живёт 30 минут

  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`req_yes_${id}`).setLabel("Принять").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`req_no_${id}`).setLabel("Отклонить").setStyle(ButtonStyle.Danger)
    );
    const content =
      "🔔 **Запрос на команду**\n" +
      `Пользователь: <@${message.author.id}> (${message.author.tag})\n` +
      `Канал: <#${message.channel.id}>\n` +
      `Команда: \`${command}\``;
    let sent = 0;
    for (const oid of ownerIds) {
      try {
        const owner = await client.users.fetch(oid);
        req.dmMessages.push(await owner.send({ content, components: [row] }));
        sent++;
      } catch (e) {
        console.error(`[бот] Не удалось отправить ЛС владельцу ${oid}:`, e && e.message ? e.message : e);
      }
    }
    if (!sent) throw new Error("ни один владелец не принял ЛС");
    await message.reply("⏳ Запрос отправлен владельцу на одобрение. После подтверждения команда будет выполнена.");
  } catch (e) {
    pendingRequests.delete(id);
    console.error("[бот] Не удалось отправить ЛС владельцам:", e && e.message ? e.message : e);
    await message.reply("⚠️ Не удалось отправить запрос владельцу (у него закрыты личные сообщения).");
  }
}

// Выполнение одобренной команды в основном канале бота + упоминание просителя
async function executeApproved(req) {
  try {
    const channel = await client.channels.fetch(allowedChannels[0]);
    if (!channel || !channel.isTextBased()) return;
    const fakeMessage = {
      channel,
      author: { id: req.userId, bot: false },
      reply: (c) => channel.send(c)
    };
    await channel.send(`<@${req.userId}>, ваша команда \`${req.command}\` одобрена ✅`);

    const args = req.command.trim().split(/\s+/);
    const cmd = args[0].toLowerCase();
    if (cmd === "!stats") return await cmdStats(fakeMessage);
    if (cmd === "!reload") return await cmdReload(fakeMessage);
    if (cmd === "!clear") return await cmdClear(fakeMessage);
    if (cmd === "!mod_add" || cmd === "!add_mod") return await cmdModAdd(fakeMessage, args);
    if (cmd === "!mod_del" || cmd === "!del_mod") return await cmdModDel(fakeMessage, args);
    if (cmd === "!swap_rank") return await cmdSwapRank(fakeMessage, args);
    if (cmd === "!norma") return await cmdNorma(fakeMessage, args);
    if (cmd === "!name") return await cmdName(fakeMessage, args);
    if (cmd === "!discord") return await cmdDiscord(fakeMessage, args);
    if (cmd === "!info") return await cmdInfo(fakeMessage, args);
    if (cmd === "!discords") return await cmdDiscords(fakeMessage);
    if (cmd === "!specstats") return await cmdSpecstats(fakeMessage, args);
    if (cmd === "!unspec") return await cmdSpecstats(fakeMessage, ["!specstats", "off"]);
    if (cmd === "!help" || cmd === "!помощь") return await channel.send(HELP_TEXT);
    await channel.send(`\`${cmd}\` — неизвестная команда. Список: \`!help\``);
  } catch (e) {
    console.error("[бот] Ошибка выполнения одобренной команды:", e);
  }
}

// Кнопки Принять/Отклонить в ЛС владельцев (решить может любой владелец)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  // кнопка "Всё хорошо" (!zav)
  if (interaction.customId === "zav_ok") {
    if (!ownerIds.includes(interaction.user.id)) {
      await interaction.reply({ content: "Эта кнопка не для вас.", ephemeral: true });
      return;
    }
    await confirmZav(interaction.user.id);
    console.log(`[бот] zav: подтверждение кнопкой от ${interaction.user.tag}`);
    await interaction.update({ content: interaction.message.content + "\n\n✅ Отлично! Подтверждено — таймер сброшен.", components: [] });
    return;
  }

  // кнопка "Отменить отправку" для отложенного !msg
  const cancel = interaction.customId.match(/^msg_cancel_([a-f0-9]+)$/);
  if (cancel) {
    if (!ownerIds.includes(interaction.user.id)) {
      await interaction.reply({ content: "Отменить может только владелец.", ephemeral: true });
      return;
    }
    const state = loadState();
    const job = (state.scheduledMsgs || {})[cancel[1]];
    if (!job) {
      await interaction.update({ content: interaction.message.content + "\n\n⚠️ Уже отправлено или отменено.", components: [] });
      return;
    }
    delete state.scheduledMsgs[cancel[1]];
    saveState(state);
    console.log(`[бот] Отложенное сообщение ${cancel[1]} отменено ${interaction.user.tag}`);
    await interaction.update({ content: interaction.message.content + "\n\n❌ Отправка отменена.", components: [] });
    return;
  }

  // кнопка "Последние 20 наказаний" из specstats-подписки
  const spec = interaction.customId.match(/^spec_last20_(\d+)$/);
  if (spec) {
    if (interaction.user.id !== spec[1]) {
      await interaction.reply({ content: "Эта кнопка не для вас.", ephemeral: true });
      return;
    }
    const state = loadState();
    const sub = (state.specsubs || {})[spec[1]];
    const mod = sub && stats && stats.moderators.find((m) => m.steamid === sub.steamid);
    if (!mod) {
      await interaction.reply({ content: "Данные устарели — оформите подписку заново: `!specstats <SteamID>`", ephemeral: true });
      return;
    }
    const recs = mod.records.slice(0, 20); // уже отсортированы от новых к старым
    const fmtD = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const stTxt = (r) => (r.excluded ? "исключён" : r.status === 2 ? "снят" : r.status === 1 ? "активен" : "истёк");
    const lines = recs.map(
      (r) => `${r.kind === "ban" ? "🔨" : "🔕"} **${r.player}** — ${r.reason} (${fmtD.format(new Date(r.created * 1000))}, ${r.durationLabel}, ${stTxt(r)})`
    );
    const emb = new EmbedBuilder()
      .setColor(0x4d70ef)
      .setTitle(`Последние ${recs.length} наказаний — ${mod.name}`)
      .setDescription(lines.join("\n") || "Нет наказаний в этом месяце");
    await interaction.reply({ embeds: [emb] });
    return;
  }

  const match = interaction.customId.match(/^req_(yes|no)_(\d+)$/);
  if (!match) return;
  if (!ownerIds.includes(interaction.user.id)) {
    await interaction.reply({ content: "Решать могут только владельцы бота.", ephemeral: true });
    return;
  }
  const req = pendingRequests.get(match[2]);
  if (!req) {
    await interaction.update({ content: interaction.message.content + "\n\n⚠️ Запрос устарел или уже обработан.", components: [] });
    return;
  }
  pendingRequests.delete(match[2]);

  const decided = match[1] === "no" ? "❌ Отклонено" : "✅ Одобрено, выполняю…";
  const who = `<@${interaction.user.id}>`;
  // обновляем ЛС у всех владельцев: у нажавшего — через interaction, у остальных — редактированием
  for (const dm of req.dmMessages || []) {
    try {
      if (interaction.message && dm.id === interaction.message.id) {
        await interaction.update({ content: interaction.message.content + `\n\n${decided} (${who})`, components: [] });
      } else {
        await dm.edit({ content: dm.content + `\n\n${decided} (${who})`, components: [] });
      }
    } catch (e) {
      console.error("[бот] Ошибка обновления ЛС:", e && e.message ? e.message : e);
    }
  }
  if (!(req.dmMessages || []).length) {
    await interaction.update({ content: interaction.message.content + `\n\n${decided} (${who})`, components: [] });
  }
  if (match[1] === "no") return;
  await executeApproved(req);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // личные сообщения — приём config.vdf
  if (!message.guildId) {
    try {
      return await handleDm(message);
    } catch (e) {
      console.error("[бот] Ошибка обработки ЛС:", e);
      return;
    }
  }

  const trimmed = message.content.trim();
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();

  // c.-команды (взаимодействия + модерация, как у Akemi) — любой канал
  if (firstWord.startsWith("c.")) {
    const fcmd = firstWord.slice(2).toLowerCase();
    const fargs = trimmed.split(/\s+/).slice(1);
    try {
      if (interactions.has(fcmd)) return await interactions.handle(client, message, fcmd);
      await moderation.handle(client, message, fcmd, fargs); // неизвестные — молчим
    } catch (e) {
      console.error(`[бот] c.${fcmd}:`, e && e.message ? e.message : e);
    }
    return;
  }

  // Dot-команды: удалить команду и отправить текст (владельцы + разрешённые, любой канал)
  const dotText = DOT_COMMANDS[trimmed.toLowerCase()];
  if (dotText) {
    if (!ownerIds.includes(message.author.id) && !bolotniyUsers.includes(message.author.id)) return;
    try {
      await message.delete();
    } catch (e) {
      console.error(`[бот] ${firstWord}: не удалось удалить сообщение:`, e && e.message ? e.message : e);
    }
    try {
      await message.channel.send(dotText);
    } catch (e) {
      console.error(`[бот] ${firstWord}: ошибка отправки:`, e && e.message ? e.message : e);
    }
    return;
  }



  // Звуковые команды (!koza1/!koza2/!svin) — владельцы + разрешённые, любой канал
  if (SOUND_COMMANDS[firstWord]) {
    if (!ownerIds.includes(message.author.id) && !bolotniyUsers.includes(message.author.id)) return;
    try {
      return await cmdSound(message, SOUND_COMMANDS[firstWord]);
    } catch (e) {
      console.error(`[бот] sound ${firstWord}:`, e && e.message ? e.message : e);
      return;
    }
  }

  // !say для разрешённых пользователей — в любом канале
  if (firstWord === "!say" && bolotniyUsers.includes(message.author.id)) {
    try {
      return await cmdSay(message, message.content.trim().split(/\s+/));
    } catch (e) {
      console.error("[бот] Ошибка !say (разрешённый):", e);
      return;
    }
  }

  // !vdf — проверка config.vdf, в канале запросов, любой пользователь (в т.ч. владельцы)
  if (firstWord === "!vdf") {
    try {
      return await cmdVdf(message);
    } catch (e) {
      console.error("[бот] Ошибка !vdf:", e);
      return;
    }
  }

  // !m — только в канале запросов и только для обычных пользователей.
  // Владельцы пользуются командами напрямую в основном канале — на их !m бот молчит.
  if (/^!m(\s+|$)/i.test(trimmed)) {
    if (requestChannelId && message.channel.id !== requestChannelId) return;
    if (ownerIds.includes(message.author.id)) return;
    try {
      return await handleMentionCommand(message);
    } catch (e) {
      console.error("[бот] Ошибка обработки !m:", e);
      return;
    }
  }

  if (ownerIds.length && !ownerIds.includes(message.author.id)) {
    // обычный пользователь пытается использовать команду — даём инструкцию про !m
    if (KNOWN_COMMANDS.has(firstWord)) {
      try {
        await message.reply(
          `Команды бота выполняются через запрос: напишите \`!m <команда>\` в канале <#${requestChannelId}>\n` +
          "Пример: `!m !stats`"
        );
      } catch (e) {
        console.error("[бот] Ошибка отправки инструкции:", e && e.message ? e.message : e);
      }
    }
    return; // на остальное не реагируем
  }
  if (allowedChannels.length && !allowedChannels.includes(message.channel.id)) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  try {
    if (cmd === "!stats") return await cmdStats(message);
    if (cmd === "!mod_add" || cmd === "!add_mod") return await cmdModAdd(message, args);
    if (cmd === "!mod_del" || cmd === "!del_mod") return await cmdModDel(message, args);
    if (cmd === "!swap_rank") return await cmdSwapRank(message, args);
    if (cmd === "!norma") return await cmdNorma(message, args);
    if (cmd === "!name") return await cmdName(message, args);
    if (cmd === "!discord") return await cmdDiscord(message, args);
    if (cmd === "!info") return await cmdInfo(message, args);
    if (cmd === "!discords") return await cmdDiscords(message);
    if (cmd === "!dmtest") return await cmdDmTest(message, args);
    if (cmd === "!specstats") return await cmdSpecstats(message, args);
    if (cmd === "!unspec") return await cmdSpecstats(message, ["!specstats", "off"]);
    if (cmd === "!voice") return await cmdVoice(message, args);
    if (cmd === "!say") return await cmdSay(message, args);
    if (cmd === "!reload") return await cmdReload(message);
    if (cmd === "!clear") return await cmdClear(message);
    if (cmd === "!help" || cmd === "!помощь") return await message.reply(HELP_TEXT);
  } catch (e) {
    console.error("[бот] Ошибка обработки команды:", e);
  }
});

client.login(token);
