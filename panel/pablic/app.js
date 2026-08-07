"use strict";

const RANK_SHORT = { 1: "мл. мод", 2: "мод", 3: "ст. мод", 4: "админ", 5: "стафф" };
const fmtDT = (ts) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));

let ME = null;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(url, method, body) {
  const res = await fetch(url, {
    method: method || "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { location.href = "/auth/login"; throw new Error("401"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setStatus(el, text, ok = true) {
  el.textContent = text || "";
  el.className = "status-line" + (ok ? "" : " err");
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 6000);
}

/* ---------- Табы ---------- */

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("page-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "say") { loadVoiceStatus(); loadSayLog(); }
    if (t.dataset.tab === "mods") loadMods();
    if (t.dataset.tab === "moderation") loadGuild();
  });
});

/* ---------- Я + доступ ---------- */

(async function init() {
  try {
    ME = await api("/api/me");
  } catch { return; }
  document.getElementById("userBox").innerHTML =
    `${ME.avatar ? `<img src="https://cdn.discordapp.com/avatars/${ME.id}/${ME.avatar}.png?size=64" alt="">` : ""}` +
    `${esc(ME.username)}${ME.owner ? ' <span class="badge">владелец</span>' : ""} · <a href="/auth/logout" style="color:#4d70ef">выйти</a>`;
  if (ME.owner) {
    document.querySelectorAll(".owner-only").forEach((el) => (el.style.display = ""));
  }
  loadStats();
  loadVoiceStatus();
  loadSayLog();
})();

/* ---------- Статистика ---------- */

function completion(m) {
  if (!m.norma) return null;
  if (m.norma.month > 0) return { pct: Math.round((m.total / m.norma.month) * 100), done: m.total >= m.norma.month };
  if (m.norma.week > 0) return { pct: Math.round(((m.weekTotal || 0) / m.norma.week) * 100), done: (m.weekTotal || 0) >= m.norma.week };
  return null;
}

async function loadStats() {
  const s = await api("/api/stats");
  if (!s) return;
  const cards = document.getElementById("statCards");
  cards.innerHTML = [
    ["Банов", s.totals.bans], ["Мутов", s.totals.mutes], ["Всего засчитано", s.totals.total],
    ["Снято вручную", s.totals.removed], ["Исключено", s.totals.excluded || 0]
  ].map(([l, v]) => `<div class="card"><div class="card-value">${v}</div><div class="card-label">${l}</div></div>`).join("");

  const body = document.getElementById("statsBody");
  body.innerHTML = s.moderators.map((m, i) => {
    const c = completion(m);
    return `<tr>
      <td>${i + 1}</td>
      <td><b>${esc(m.name)}</b></td>
      <td>${RANK_SHORT[m.rank] || "—"}</td>
      <td>${m.bans}</td>
      <td>${m.mutes}</td>
      <td><b>${m.total}</b></td>
      <td>${m.removed}</td>
      <td>${c ? c.pct + "%" + (c.done ? " ✓" : "") : "—"}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="8" class="empty">Нет данных</td></tr>';
}

/* ---------- Озвучить ---------- */

async function loadVoiceStatus() {
  const el = document.getElementById("voiceStatus");
  try {
    const d = await api("/api/voicestatus");
    if (d.connected) {
      el.textContent = `🟢 Бот в голосовом: ${d.channel ? d.channel.name : "?"}`;
      el.className = "voice-status ok";
    } else {
      el.textContent = "🔴 Бот не в голосовом канале";
      el.className = "voice-status off";
    }
  } catch { el.textContent = "⚠️ Ошибка проверки"; el.className = "voice-status off"; }
}

async function loadSayLog() {
  const d = await api("/api/saylog");
  const box = document.getElementById("sayLog");
  box.innerHTML = (d.list && d.list.length)
    ? d.list.map((x) => `<div class="saylog-row"><span class="saylog-user">${esc(x.username)}</span><span>${esc(x.text)}</span><span class="saylog-time">${fmtDT(x.ts)} МСК</span></div>`).join("")
    : '<div class="empty">Пусто</div>';
}

document.getElementById("sayBtn").addEventListener("click", async () => {
  const inp = document.getElementById("sayText");
  const st = document.getElementById("sayStatus");
  const text = inp.value.trim();
  if (!text) return;
  try {
    await api("/api/say", "POST", { text });
    inp.value = "";
    setStatus(st, "✅ Озвучено");
    loadSayLog();
  } catch (e) {
    setStatus(st, "❌ " + e.message, false);
  }
});
document.getElementById("sayText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sayBtn").click();
});

/* ---------- Модераторы ---------- */

let RANKS = [];

async function loadMods() {
  const d = await api("/api/mods");
  RANKS = d.ranks;
  const body = document.getElementById("modsBody");
  body.innerHTML = d.moderators.map((m) => {
    const opts = d.ranks.map((r) => `<option value="${r.rank}" ${r.rank === m.rank ? "selected" : ""}>${r.rank} — ${esc(r.title)}</option>`).join("");
    return `<tr data-sid="${m.steamid}">
      <td><input class="inp inp-sm m-name" value="${m.name === m.steamid ? "" : esc(m.name)}" placeholder="${m.steamid}"></td>
      <td><select class="inp inp-sm m-rank">${opts}</select></td>
      <td><input class="inp inp-sm m-disc" value="${esc(m.discord || "")}" placeholder="—"></td>
      <td style="color:#8a90ad;font-size:12px">${m.steamid}</td>
      <td><a href="https://fearproject.ru/profile/${m.steamid}" target="_blank" style="color:#4d70ef">профиль</a></td>
      <td>
        <button class="btn btn-xs m-save">💾</button>
        <button class="btn btn-xs btn-danger m-del">🗑</button>
      </td>
    </tr>`;
  }).join("") || '<tr><td colspan="6" class="empty">Список пуст</td></tr>';

  body.querySelectorAll("tr[data-sid]").forEach((tr) => {
    const sid = tr.dataset.sid;
    const st = document.getElementById("modsStatus");
    tr.querySelector(".m-save").addEventListener("click", async () => {
      const name = tr.querySelector(".m-name").value.trim();
      const rank = Number(tr.querySelector(".m-rank").value);
      const discord = tr.querySelector(".m-disc").value.trim();
      try {
        await api("/api/mods", "PATCH", { steamid: sid, rank, discord, ...(name ? { name } : {}) });
        setStatus(st, "Сохранено");
      } catch (e) { setStatus(st, "❌ " + e.message, false); }
    });
    tr.querySelector(".m-del").addEventListener("click", async () => {
      if (!confirm(`Удалить модератора ${sid}?`)) return;
      try {
        await api("/api/mods", "DELETE", { steamid: sid });
        setStatus(st, "Удалён");
        loadMods();
      } catch (e) { setStatus(st, "❌ " + e.message, false); }
    });
  });

  const rb = document.getElementById("ranksBody");
  rb.innerHTML = d.ranks.map((r) => `<tr data-rank="${r.rank}">
    <td>${r.rank}</td><td>${esc(r.title)}</td>
    <td><input class="inp inp-sm r-week" type="number" min="0" value="${r.week}"></td>
    <td><input class="inp inp-sm r-month" type="number" min="0" value="${r.month}"></td>
    <td><button class="btn btn-xs r-save">💾</button></td>
  </tr>`).join("");
  rb.querySelectorAll("tr[data-rank]").forEach((tr) => {
    const st = document.getElementById("modsStatus");
    tr.querySelector(".r-save").addEventListener("click", async () => {
      try {
        await api("/api/ranks", "POST", { rank: Number(tr.dataset.rank), week: Number(tr.querySelector(".r-week").value) || 0, month: Number(tr.querySelector(".r-month").value) || 0 });
        setStatus(st, "Норма сохранена");
      } catch (e) { setStatus(st, "❌ " + e.message, false); }
    });
  });
}

document.getElementById("addBtn").addEventListener("click", async () => {
  const st = document.getElementById("modsStatus");
  const steamid = document.getElementById("addSteam").value.trim();
  const name = document.getElementById("addName").value.trim();
  if (!/^\d{17}$/.test(steamid)) { setStatus(st, "SteamID64 должен быть 17 цифр", false); return; }
  try {
    await api("/api/mods", "POST", { steamid, name });
    document.getElementById("addSteam").value = "";
    document.getElementById("addName").value = "";
    setStatus(st, "Добавлен (ранг 1)");
    loadMods();
  } catch (e) { setStatus(st, "❌ " + e.message, false); }
});

/* ---------- Модерация ---------- */

let ROLES = [];

async function loadGuild() {
  const d = await api("/api/guild");
  ROLES = d.roles;
}

async function loadMembers() {
  const list = document.getElementById("membersList");
  list.innerHTML = '<div class="empty">Загрузка…</div>';
  const q = document.getElementById("memberSearch").value.trim();
  const d = await api("/api/members?q=" + encodeURIComponent(q));
  const st = document.getElementById("moderationStatus");
  setStatus(st, `Найдено: ${d.members.length} (всего на сервере: ${d.total})`);

  list.innerHTML = d.members.map((m) => {
    const roleOpts = ['<option value="">— роль —</option>'].concat(
      ROLES.map((r) => `<option value="${r.id}" ${m.roles.includes(r.id) ? "selected" : ""}>${esc(r.name)}</option>`)
    ).join("");
    return `<div class="member-row" data-id="${m.id}">
      <img src="${m.avatar}" alt="">
      <div class="member-info">
        <div class="member-name">${esc(m.nickname || m.username)} ${m.timedOut ? '<span class="member-timeout">[таймаут]</span>' : ""}</div>
        <div class="member-sub">${esc(m.username)} · ${m.id}</div>
      </div>
      <div class="member-actions">
        <button class="btn btn-xs act" data-a="timeout" title="Таймаут 30 мин">🔇 30м</button>
        <button class="btn btn-xs act" data-a="untimeout" title="Снять таймаут">🔊</button>
        <button class="btn btn-xs btn-danger act" data-a="kick">👢</button>
        <button class="btn btn-xs btn-danger act" data-a="ban">🔨</button>
        <button class="btn btn-xs btn-ghost act" data-a="unban">🔓</button>
        <button class="btn btn-xs btn-ghost act" data-a="nick" title="Сменить ник">✏️</button>
        <select class="inp inp-sm role-sel">${roleOpts}</select>
        <button class="btn btn-xs act" data-a="addrole">+роль</button>
        <button class="btn btn-xs btn-ghost act" data-a="removerole">−роль</button>
      </div>
    </div>`;
  }).join("") || '<div class="empty">Никого не найдено</div>';

  list.querySelectorAll(".member-row").forEach((row) => {
    const id = row.dataset.id;
    const st = document.getElementById("moderationStatus");
    row.querySelectorAll(".act").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const a = btn.dataset.a;
        const payload = { userId: id, action: a };
        if (a === "timeout") payload.ms = 30 * 60000;
        if (a === "nick") {
          const nick = prompt("Новый ник (пусто — сброс):", "");
          if (nick === null) return;
          payload.value = nick;
        }
        if (a === "addrole" || a === "removerole") {
          const roleId = row.querySelector(".role-sel").value;
          if (!roleId) { setStatus(st, "Выберите роль в списке", false); return; }
          payload.roleId = roleId;
        }
        if (a === "ban" && !confirm("Забанить этого пользователя?")) return;
        if (a === "kick" && !confirm("Кикнуть этого пользователя?")) return;
        btn.disabled = true;
        try {
          const r = await api("/api/member-action", "POST", payload);
          setStatus(st, "✅ " + r.message);
        } catch (e) {
          setStatus(st, "❌ " + e.message, false);
        }
        btn.disabled = false;
      });
    });
  });
}

document.getElementById("memberSearchBtn").addEventListener("click", loadMembers);
document.getElementById("memberSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadMembers();
});
