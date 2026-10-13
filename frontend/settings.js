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
  update: document.getElementById("t-update"),
  lang: document.getElementById("lang"),
  soundChk: document.getElementById("sound"),
  onTopChk: document.getElementById("ontop"),
  autoStartChk: document.getElementById("autostart"),
  alarmSel: document.getElementById("alarm"),
  updBtn: document.getElementById("upd"),
  updStatus: document.getElementById("upd-status"),
  ver: document.querySelector(".ver"),
};

let currentLang = "zh-CN";
let updateState = "idle"; // idle / checking / found / downloading
let pendingUpdate = null; // 检查到的更新（含 url、latest）

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
  el.update.textContent = d.update;
  el.ver.textContent = "v" + (s.version || "0.1.2");
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
  setUpdateUI();
}

// ---- 检查更新 ----

function setUpdateUI() {
  const d = window.TimerI18N.pick(currentLang);
  el.updBtn.disabled = updateState === "checking" || updateState === "downloading";
  el.updBtn.textContent =
    updateState === "checking" ? d.checking :
    updateState === "downloading" ? d.downloading :
    updateState === "found" ? d.downloadUpdate :
    d.checkUpdate;
}

function setUpdStatus(text, isErr) {
  el.updStatus.textContent = text || "";
  el.updStatus.classList.toggle("err", !!isErr);
}

async function onCheckUpdate() {
  const d = window.TimerI18N.pick(currentLang);
  if (updateState === "idle") {
    updateState = "checking";
    setUpdStatus("");
    setUpdateUI();
    const info = await window.mygo.call("Timer.CheckUpdate").catch((e) => ({ message: String(e) }));
    if (updateState !== "checking") return; // 期间状态被外部改动
    if (info.message) {
      setUpdStatus(d.updateFailed + ": " + info.message, true);
      updateState = "idle";
    } else if (info.hasUpdate) {
      pendingUpdate = info;
      updateState = "found";
      setUpdStatus(d.updateFound + ": v" + info.latest);
    } else {
      setUpdStatus(d.upToDate);
      updateState = "idle";
      setTimeout(() => { if (updateState === "idle") setUpdStatus(""); }, 3000);
    }
    setUpdateUI();
  } else if (updateState === "found" && pendingUpdate) {
    updateState = "downloading";
    setUpdateUI();
    const err = await window.mygo.call("Timer.ApplyUpdate", pendingUpdate.url)
      .then(() => null)
      .catch((e) => String(e));
    if (err) {
      setUpdStatus(d.updateFailed + ": " + err, true);
      updateState = "found";
      setUpdateUI();
      return;
    }
    // 更新已就绪，应用即将退出并自动重启
    setUpdStatus(d.downloading);
  }
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
    el.updBtn.addEventListener("click", () => onCheckUpdate().catch((e) => console.error(e)));
    if (typeof window.mygo.on === "function") {
      window.mygo.on("state", applyState);
    }
    applyState(await window.mygo.call("Timer.LoadSettings"));
  } else {
    applyState({ version: "0.1.2", lang: "zh-CN", sound: true, alwaysOnTop: true, autoStart: false, alarm: "loop" });
  }
}

init();
