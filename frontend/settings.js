// 设置窗口：语言 + 提示音/置顶/自启。
// 状态以 Go 为唯一事实源：任何一处改动后 Go 广播 state 事件，本页据此重渲染。
"use strict";

const inMyGo = typeof window.mygo !== "undefined" && !!window.mygo.call;

const el = {
  title: document.getElementById("t-settings"),
  language: document.getElementById("t-language"),
  sound: document.getElementById("t-sound"),
  onTop: document.getElementById("t-ontop"),
  autoStart: document.getElementById("t-autostart"),
  alarm: document.getElementById("t-alarm"),
  lang: document.getElementById("lang"),
  soundChk: document.getElementById("sound"),
  onTopChk: document.getElementById("ontop"),
  autoStartChk: document.getElementById("autostart"),
  alarmSel: document.getElementById("alarm"),
};

let currentLang = "zh-CN";

function applyState(s) {
  if (!s) return;
  currentLang = s.lang || "zh-CN";
  const d = window.TimerI18N.pick(currentLang);
  document.title = d.settings;
  document.documentElement.lang = currentLang;
  el.title.textContent = d.settings;
  el.language.textContent = d.language;
  el.sound.textContent = d.sound;
  el.onTop.textContent = d.onTop;
  el.autoStart.textContent = d.autoStart;
  el.alarm.textContent = d.alarm;
  // 铃声时长选项文案随语言刷新（value 不变）
  for (const opt of el.alarmSel.options) {
    if (opt.value === "once") opt.textContent = d.alarmOnce;
    else if (opt.value === "10") opt.textContent = d.alarm10;
    else if (opt.value === "30") opt.textContent = d.alarm30;
    else if (opt.value === "loop") opt.textContent = d.alarmLoop;
  }

  // 避免回显覆盖正在进行的交互
  if (document.activeElement !== el.lang) el.lang.value = currentLang;
  if (document.activeElement !== el.alarmSel) el.alarmSel.value = s.alarm || "loop";
  el.soundChk.checked = s.sound !== false;
  el.onTopChk.checked = s.alwaysOnTop === true;
  el.autoStartChk.checked = s.autoStart === true;
}

async function init() {
  if (inMyGo) {
    el.lang.addEventListener("change", () =>
      window.mygo.call("Timer.SetLang", el.lang.value).catch((e) => console.error(e)));
    el.alarmSel.addEventListener("change", () =>
      window.mygo.call("Timer.SetAlarm", el.alarmSel.value).catch((e) => console.error(e)));
    el.soundChk.addEventListener("change", () =>
      window.mygo.call("Timer.SetSound", el.soundChk.checked).catch((e) => console.error(e)));
    el.onTopChk.addEventListener("change", () =>
      window.mygo.call("Timer.SetAlwaysOnTop", el.onTopChk.checked).catch((e) => console.error(e)));
    el.autoStartChk.addEventListener("change", () =>
      window.mygo.call("Timer.SetAutoStart", el.autoStartChk.checked).catch((e) => console.error(e)));
    if (typeof window.mygo.on === "function") {
      window.mygo.on("state", applyState);
    }
    applyState(await window.mygo.call("Timer.LoadSettings"));
  } else {
    applyState({ lang: "zh-CN", sound: true, alwaysOnTop: true, autoStart: false, alarm: "loop" });
  }
}

init();
