"use strict";

// Команды взаимодействия (f.<действие> [@user]) — как у Akemi.
// GIF через nekos.life (без ключа), где эндпоинта нет — текстовая фраза.

const { EmbedBuilder } = require("discord.js");

// gif — эндпоинт nekos.life (или null = только текст)
// target — фраза с целью ({a} — автор, {b} — цель), self — без цели
const INTERACTIONS = {
  airkiss: { gif: null, target: "{a} посылает воздушный поцелуй {b} 💋", self: "{a} посылает воздушный поцелуй всем 💋" },
  bite: { gif: null, target: "{a} кусает {b} 😬", self: "{a} кусается 😬" },
  bleh: { gif: null, target: "{a} показывает язык {b} 😝", self: "{a} показывает язык 😝" },
  blush: { gif: null, target: "{a} краснеет из-за {b} ☺️", self: "{a} краснеет ☺️" },
  celebrate: { gif: null, target: "{a} празднует с {b} 🎉", self: "{a} празднует 🎉" },
  clap: { gif: null, target: "{a} аплодирует {b} 👏", self: "{a} аплодирует 👏" },
  confused: { gif: null, target: "{a} в замешательстве из-за {b} 😕", self: "{a} в замешательстве 😕" },
  cool: { gif: null, target: "{a} считает {b} крутым 😎", self: "{a} крут 😎" },
  cry: { gif: null, target: "{a} плачет из-за {b} 😭", self: "{a} плачет 😭" },
  dance: { gif: null, target: "{a} танцует с {b} 💃", self: "{a} танцует 💃" },
  evillaugh: { gif: null, target: "{a} злорадно смеётся над {b} 😈", self: "{a} злорадно смеётся 😈" },
  facepalm: { gif: null, target: "{a} делает фейспалм из-за {b} 🤦", self: "{a} делает фейспалм 🤦" },
  handhold: { gif: "cuddle", target: "{a} держит {b} за руку 🤝", self: "{a} протягивает руку 🤝" },
  happy: { gif: null, target: "{a} радуется из-за {b} 😊", self: "{a} радуется 😊" },
  hug: { gif: "hug", target: "{a} обнимает {b} 🤗", self: "{a} обнимает всех 🤗" },
  kiss: { gif: "kiss", target: "{a} целует {b} 💋", self: "{a} целует всех 💋" },
  laugh: { gif: null, target: "{a} смеётся над {b} 😂", self: "{a} смеётся 😂" },
  lick: { gif: null, target: "{a} облизывает {b} 😋", self: "{a} облизывается 😋" },
  love: { gif: "cuddle", target: "{a} любит {b} ❤️", self: "{a} любит всех ❤️" },
  mad: { gif: null, target: "{a} злится на {b} 😠", self: "{a} злится 😠" },
  no: { gif: null, target: "{a} говорит {b} «нет» 🙅", self: "{a} говорит «нет» 🙅" },
  nyah: { gif: null, target: "{a} дразнит {b} 😜", self: "{a} дразнится 😜" },
  pat: { gif: "pat", target: "{a} гладит {b} 🥰", self: "{a} гладит всех 🥰" },
  peek: { gif: null, target: "{a} подглядывает за {b} 👀", self: "{a} подглядывает 👀" },
  pinch: { gif: null, target: "{a} щиплет {b} 🤏", self: "{a} щиплет себя 🤏" },
  poke: { gif: null, target: "{a} тычет в {b} 👉", self: "{a} тычет в воздух 👉" },
  punch: { gif: null, target: "{a} бьёт {b} 👊", self: "{a} размахивает кулаками 👊" },
  run: { gif: null, target: "{a} убегает от {b} 🏃", self: "{a} убегает 🏃" },
  sad: { gif: null, target: "{a} грустит из-за {b} 😔", self: "{a} грустит 😔" },
  scared: { gif: null, target: "{a} боится {b} 😨", self: "{a} боится 😨" },
  shrug: { gif: null, target: "{a} пожимает плечами на {b} 🤷", self: "{a} пожимает плечами 🤷" },
  shy: { gif: null, target: "{a} стесняется {b} 😳", self: "{a} стесняется 😳" },
  slap: { gif: "slap", target: "{a} даёт пощёчину {b} 👋", self: "{a} машет рукой 👋" },
  sleep: { gif: null, target: "{a} засыпает рядом с {b} 😴", self: "{a} засыпает 😴" },
  smile: { gif: null, target: "{a} улыбается {b} 🙂", self: "{a} улыбается 🙂" },
  smug: { gif: "smug", target: "{a} ухмыляется {b} 😏", self: "{a} ухмыляется 😏" },
  sorry: { gif: null, target: "{a} извиняется перед {b} 🙏", self: "{a} извиняется 🙏" },
  stare: { gif: null, target: "{a} пялится на {b} 👁️", self: "{a} пялится 👁️" },
  surprised: { gif: null, target: "{a} удивлён из-за {b} 😲", self: "{a} удивлён 😲" },
  sweat: { gif: null, target: "{a} потеет из-за {b} 😅", self: "{a} потеет 😅" },
  thumbsup: { gif: null, target: "{a} показывает {b} большой палец 👍", self: "{a} показывает большой палец 👍" },
  tickle: { gif: "tickle", target: "{a} щекочет {b} 🤭", self: "{a} щекочет всех 🤭" },
  wink: { gif: null, target: "{a} подмигивает {b} 😉", self: "{a} подмигивает 😉" },
  yay: { gif: null, target: "{a} радуется с {b} 🙌", self: "{a} радуется 🙌" },
  yea: { gif: null, target: "{a} одобряет {b} 👍", self: "{a} одобряет 👍" }
};

function has(cmd) {
  return Object.prototype.hasOwnProperty.call(INTERACTIONS, cmd);
}

async function gifUrl(endpoint) {
  try {
    const r = await fetch(`https://nekos.life/api/v2/img/${endpoint}`, {
      headers: { "User-Agent": "ModStatsFear/1.0" }
    });
    if (!r.ok) return null;
    return (await r.json()).url || null;
  } catch {
    return null;
  }
}

async function handle(client, message, cmd) {
  const conf = INTERACTIONS[cmd];
  const target = message.mentions.users.first();
  const a = `<@${message.author.id}>`;
  const text = target
    ? conf.target.replace("{a}", a).replace("{b}", `<@${target.id}>`)
    : conf.self.replace("{a}", a);
  const emb = new EmbedBuilder().setColor(0xff8fb3).setDescription(text);
  if (conf.gif) {
    const url = await gifUrl(conf.gif);
    if (url) emb.setImage(url);
  }
  await message.channel.send({ embeds: [emb] });
}

module.exports = { has, handle };
