// 设置窗口：语言 + 计时模式/循环作息/课表 + 提示音/置顶/自启。
// 状态以 Go 为唯一事实源：任何一处改动后 Go 广播 state 事件，本页据此重渲染。
"use strict";

const inMyGo = typeof window.mygo !== "undefined" && !!window.mygo.call;

const el = {
  title: document.getElementById("t-settings"),
  language: document.getElementById("t-language"),
  sound: document.getElementById("t-sound"),
  anim: document.getElementById("t-anim"),
  onTop: document.getElementById("t-ontop"),
  autoStart: document.getElementById("t-autostart"),
  alarm: document.getElementById("t-alarm"),
  update: document.getElementById("t-update"),
  lang: document.getElementById("lang"),
  soundChk: document.getElementById("sound"),
  animChk: document.getElementById("anim"),
  onTopChk: document.getElementById("ontop"),
  autoStartChk: document.getElementById("autostart"),
  alarmSel: document.getElementById("alarm"),
  updBtn: document.getElementById("upd"),
  updStatus: document.getElementById("upd-status"),
  ver: document.querySelector(".ver"),
  navGeneral: document.getElementById("t-nav-general"),
  navTimetable: document.getElementById("t-nav-timetable"),
  // 循环作息
  modeLabel: document.getElementById("t-mode"),
  cycleWorkLabel: document.getElementById("t-cycle-work"),
  cycleRestLabel: document.getElementById("t-cycle-rest"),
  cycleLongRestLabel: document.getElementById("t-cycle-long-rest"),
  cycleLongEveryLabel: document.getElementById("t-cycle-long-every"),
  cycleAutoLabel: document.getElementById("t-cycle-auto"),
  minWork: document.getElementById("t-min-work"),
  minRest: document.getElementById("t-min-rest"),
  minLong: document.getElementById("t-min-long"),
  roundUnit: document.getElementById("t-round-unit"),
  longHint: document.getElementById("t-long-hint"),
  schedTitle: document.getElementById("t-sched"),
  schedHint: document.getElementById("t-sched-hint"),
  modeSel: document.getElementById("mode"),
  cycleWork: document.getElementById("cycleWork"),
  cycleRest: document.getElementById("cycleRest"),
  cycleLongRest: document.getElementById("cycleLongRest"),
  cycleLongEvery: document.getElementById("cycleLongEvery"),
  cycleAutoChk: document.getElementById("cycleAuto"),
  schedList: document.getElementById("schedList"),
  schedAdd: document.getElementById("schedAdd"),
};

let currentLang = "zh-CN";
let updateState = "idle"; // idle / checking / found / downloading
let pendingUpdate = null; // 检查到的更新（含 url、latest）

function applyTexts(d) {
  document.title = d.settings;
  document.documentElement.lang = currentLang;
  el.title.textContent = d.settings;
  el.language.textContent = d.language;
  el.sound.textContent = d.sound;
  el.anim.textContent = d.anim;
  el.onTop.textContent = d.onTop;
  el.autoStart.textContent = d.autoStart;
  el.alarm.textContent = d.alarm;
  el.update.textContent = d.update;
  // 循环作息
  el.modeLabel.textContent = d.modeLabel;
  el.navGeneral.textContent = d.navGeneral;
  el.navTimetable.textContent = d.navTimetable;
  el.cycleWorkLabel.textContent = d.cycleWork;
  el.cycleRestLabel.textContent = d.cycleRest;
  el.cycleLongRestLabel.textContent = d.cycleLongRest;
  el.cycleLongEveryLabel.textContent = d.cycleLongEvery;
  el.cycleAutoLabel.textContent = d.cycleAuto;
  el.minWork.textContent = d.unit;
  el.minRest.textContent = d.unit;
  el.minLong.textContent = d.unit;
  el.roundUnit.textContent = d.roundUnit;
  el.longHint.textContent = d.longEveryHint;
  el.schedTitle.textContent = d.schedTitle;
  el.schedHint.textContent = d.schedEmpty;
  el.schedAdd.textContent = d.schedAdd;
  // 模式选项文案随语言刷新（value 不变）
  for (const opt of el.modeSel.options) {
    if (opt.value === "countdown") opt.textContent = d.modeCountdown;
    else if (opt.value === "cycle") opt.textContent = d.modeCycle;
  }
  // 铃声时长选项文案随语言刷新（value 不变）
  for (const opt of el.alarmSel.options) {
    if (opt.value === "once") opt.textContent = d.alarmOnce;
    else if (opt.value === "10") opt.textContent = d.alarm10;
    else if (opt.value === "30") opt.textContent = d.alarm30;
    else if (opt.value === "loop") opt.textContent = d.alarmLoop;
  }
}

function applyState(s) {
  if (!s) return;
  currentLang = s.lang || "zh-CN";
  const d = window.TimerI18N.pick(currentLang);
  applyTexts(d);
  el.ver.textContent = "v" + (s.version || "0.1.2");

  // 避免回显覆盖正在进行的交互
  if (document.activeElement !== el.lang) el.lang.value = currentLang;
  if (document.activeElement !== el.alarmSel) el.alarmSel.value = s.alarm || "loop";
  if (document.activeElement !== el.modeSel) el.modeSel.value = s.mode === "cycle" ? "cycle" : "countdown";
  if (document.activeElement !== el.cycleWork) el.cycleWork.value = s.cycleWork > 0 ? s.cycleWork : 45;
  if (document.activeElement !== el.cycleRest) el.cycleRest.value = s.cycleRest > 0 ? s.cycleRest : 10;
  if (document.activeElement !== el.cycleLongRest) el.cycleLongRest.value = s.cycleLongRest > 0 ? s.cycleLongRest : 15;
  if (document.activeElement !== el.cycleLongEvery) el.cycleLongEvery.value = s.cycleLongEvery > 0 ? s.cycleLongEvery : 0;
  el.cycleAutoChk.checked = s.cycleAuto !== false;
  el.soundChk.checked = s.sound !== false;
  el.animChk.checked = s.anim !== false;
  el.onTopChk.checked = s.alwaysOnTop === true;
  el.autoStartChk.checked = s.autoStart === true;

  // 课表编辑中（任一输入框持有焦点）不重建列表，等失焦后由下一次广播刷新
  if (!el.schedList.contains(document.activeElement)) {
    renderSchedule(Array.isArray(s.schedule) ? s.schedule : []);
  }
  setUpdateUI();
}

// ---- 每日课表编辑器 ----

// renderSchedule 按数据重建课表行。
function renderSchedule(rules) {
  el.schedList.textContent = "";
  for (const r of rules) el.schedList.appendChild(makeSchedRow(r));
  updateSchedHint();
}

// makeSchedRow 生成一行：[拖动手柄] [开始] – [结束] [类型] [删除]。任何改动立即整表保存。
function makeSchedRow(rule) {
  const d = window.TimerI18N.pick(currentLang);
  const row = document.createElement("div");
  row.className = "sched-row";

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⋮⋮";
  grip.title = d.schedDrag;
  makeDraggable(row, grip);

  const start = document.createElement("input");
  start.type = "time";
  start.value = rule.start || "09:00";
  const dash = document.createElement("span");
  dash.className = "dash";
  dash.textContent = "–";
  const end = document.createElement("input");
  end.type = "time";
  end.value = rule.end || "12:00";

  const type = document.createElement("select");
  for (const [v, key] of [["cycle", "schedCycle"], ["break", "schedBreak"]]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = d[key];
    type.appendChild(opt);
  }
  type.value = rule.type === "break" ? "break" : "cycle";

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "✕";
  del.title = "✕";
  del.addEventListener("click", () => {
    row.remove();
    commitSchedule();
  });

  for (const input of [start, end, type]) {
    input.addEventListener("change", commitSchedule);
  }
  row.append(grip, start, dash, end, type, del);
  return row;
}

// makeDraggable 手柄拖动排序：按住手柄上下拖，越过相邻行中点即交换位置。
function makeDraggable(row, grip) {
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const step = row.offsetHeight + 5; // 行高 + 行距
    let startY = e.clientY;
    let dy = 0;
    let moved = false;
    row.classList.add("dragging");
    const onMove = (ev) => {
      dy = ev.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      if (dy > step / 2) {
        const next = row.nextElementSibling;
        if (next) {
          row.parentElement.insertBefore(next, row);
          startY += step;
          dy -= step;
          row.style.transform = `translateY(${dy}px)`;
          moved = true;
        }
      } else if (dy < -step / 2) {
        const prev = row.previousElementSibling;
        if (prev) {
          row.parentElement.insertBefore(row, prev);
          startY -= step;
          dy += step;
          row.style.transform = `translateY(${dy}px)`;
          moved = true;
        }
      }
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      row.style.transform = "";
      row.classList.remove("dragging");
      if (moved) commitSchedule(); // 顺序变了就整表保存
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });
}

// nextSlotDefaults 新增行的默认值：接着最后一行的结束时间开始（列表里始终追加
// 在末尾），类型与上一行交替（循环↔休息），半小时或一小时由用户自行调整。
function nextSlotDefaults() {
  const last = el.schedList.lastElementChild;
  if (!last) return { start: "09:00", end: "12:00", type: "cycle" };
  const times = last.querySelectorAll("input");
  const type = last.querySelector("select");
  const end = times[1].value || "18:00";
  const plus = (hm, add) => {
    const m = parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10) + add;
    if (m >= 24 * 60) return "23:59";
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  };
  return {
    start: end,
    end: plus(end, 60),
    type: type && type.value === "break" ? "cycle" : "break",
  };
}

// commitSchedule 从 DOM 收集课表整表保存；非法条目由 Go 侧统一剔除。
function commitSchedule() {
  const rules = [];
  for (const row of el.schedList.children) {
    const times = row.querySelectorAll("input");
    const type = row.querySelector("select");
    rules.push({ start: times[0].value, end: times[1].value, type: type.value });
  }
  updateSchedHint();
  if (inMyGo) {
    window.mygo.call("Timer.SaveSchedule", rules).catch((e) => console.error(e));
  } else {
    const s = lsLoad();
    s.schedule = rules;
    localStorage.setItem("timer-state", JSON.stringify(s));
  }
}

function updateSchedHint() {
  el.schedHint.style.display = el.schedList.children.length ? "none" : "";
}

// ---- 导航分区 ----

// switchPanel 切换左侧导航选中项与右侧显示的分区。
function switchPanel(name) {
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", item.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === "panel-" + name);
  }
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

// 浏览器调试降级用的本地状态
function lsLoad() {
  try { return JSON.parse(localStorage.getItem("timer-state")) || {}; }
  catch { return {}; }
}

async function init() {
  for (const item of document.querySelectorAll(".nav-item")) {
    item.addEventListener("click", () => switchPanel(item.dataset.panel));
  }
  if (inMyGo) {
    el.lang.addEventListener("change", () =>
      window.mygo.call("Timer.SetLang", el.lang.value).catch((e) => console.error(e)));
    el.alarmSel.addEventListener("change", () =>
      window.mygo.call("Timer.SetAlarm", el.alarmSel.value).catch((e) => console.error(e)));
    el.modeSel.addEventListener("change", () =>
      window.mygo.call("Timer.SetMode", el.modeSel.value).catch((e) => console.error(e)));
    el.cycleWork.addEventListener("change", commitCycle);
    el.cycleRest.addEventListener("change", commitCycle);
    el.cycleLongRest.addEventListener("change", commitCycle);
    el.cycleLongEvery.addEventListener("change", commitCycle);
    el.cycleAutoChk.addEventListener("change", commitCycle);
    el.schedAdd.addEventListener("click", () => {
      el.schedList.appendChild(makeSchedRow(nextSlotDefaults()));
      commitSchedule();
    });
    el.soundChk.addEventListener("change", () =>
      window.mygo.call("Timer.SetSound", el.soundChk.checked).catch((e) => console.error(e)));
    el.animChk.addEventListener("change", () =>
      window.mygo.call("Timer.SetAnim", el.animChk.checked).catch((e) => console.error(e)));
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
    // 浏览器调试：给一份带课表的样例，便于单独调样式
    applyState({
      version: "0.2.0", lang: "zh-CN", sound: true, alwaysOnTop: true, autoStart: false,
      alarm: "loop", mode: "cycle", cycleWork: 45, cycleRest: 10, cycleLongEvery: 4, cycleLongRest: 15,
      cycleAuto: true,
      schedule: [
        { start: "09:00", end: "12:00", type: "cycle" },
        { start: "12:00", end: "13:30", type: "break" },
        { start: "13:30", end: "18:30", type: "cycle" },
      ],
    });
  }
}

// commitCycle 保存工作/休息/长休息参数与自动切换开关。
function commitCycle() {
  const num = (input) => parseInt(input.value, 10);
  if (inMyGo) {
    window.mygo.call("Timer.SaveCycle", num(el.cycleWork), num(el.cycleRest),
      num(el.cycleLongEvery), num(el.cycleLongRest), el.cycleAutoChk.checked)
      .catch((e) => console.error(e));
  } else {
    const s = lsLoad();
    s.cycleWork = num(el.cycleWork); s.cycleRest = num(el.cycleRest);
    s.cycleLongEvery = num(el.cycleLongEvery); s.cycleLongRest = num(el.cycleLongRest);
    s.cycleAuto = el.cycleAutoChk.checked;
    localStorage.setItem("timer-state", JSON.stringify(s));
  }
}

init();
