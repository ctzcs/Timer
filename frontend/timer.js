// 计时逻辑：基于时间戳差值（不靠 tick 累加），系统休眠/节流后仍准确。
// 窗口操作（隐藏）与时长持久化走 mygo.call("Timer.xxx")；
// 语言等状态以 Go 为唯一事实源，通过 state 事件推送同步。
// 在普通浏览器里打开时自动降级到 localStorage，便于单独调试样式。
"use strict";

const SEGMENTS = 30; // 刻度条段数，与实体机一致
const BLINK_WARN_SEC = 10; // 最后 N 秒末段闪红

const bar = document.getElementById("bar");
const lcd = document.getElementById("lcd");
const digitsEl = document.getElementById("digits");
const controls = document.getElementById("controls");
const minsInput = document.getElementById("mins");
const unitEl = document.getElementById("unit");
const durWrap = document.getElementById("durWrap");
const device = document.getElementById("device");

// 段元素
const segs = [];
for (let i = 0; i < SEGMENTS; i++) {
  const s = document.createElement("div");
  s.className = "seg";
  bar.appendChild(s);
  segs.push(s);
}

// ---- 状态 ----

let totalSec = 30 * 60;   // 设定时长
let remainSec = totalSec; // 剩余秒（暂停/未开始时等于当前值）
let endTs = 0;            // 运行中的结束时间戳（ms）
let running = false;
let finished = false;
let soundOn = true;
let lang = "zh-CN";
let alarmSetting = "loop"; // once / 10 / 30 / loop
let alarmTimer = null;     // 循环响的定时器
let animOn = true;         // 动态效果开关
let beepCtx = null;

// ---- MyGo IPC（带浏览器降级） ----

const inMyGo = typeof window.mygo !== "undefined" && !!window.mygo.call;

async function ipc(method, ...args) {
  if (inMyGo) {
    try { return await window.mygo.call("Timer." + method, ...args); }
    catch (e) { console.error("ipc failed:", method, e); }
    return;
  }
  // 浏览器调试降级
  if (method === "LoadSettings") {
    try {
      const s = JSON.parse(localStorage.getItem("timer-state"));
      return s || { minutes: 30, sound: true, alwaysOnTop: true, autoStart: false, lang: "zh-CN" };
    } catch { return { minutes: 30, sound: true, alwaysOnTop: true, autoStart: false, lang: "zh-CN" }; }
  }
  if (method === "SaveMinutes") {
    const s = await ipc("LoadSettings");
    s.minutes = args[0];
    localStorage.setItem("timer-state", JSON.stringify(s));
  }
}

// ---- 文案与状态应用 ----

function applyTexts() {
  const d = window.TimerI18N.pick(lang);
  bar.title = d.barTip;
  lcd.title = d.lcdTip;
  durWrap.title = d.durTip;
  minsInput.title = d.durTip;
  unitEl.textContent = d.unit;
  for (const [act, key] of [["m5", "actM5"], ["m1", "actM1"], ["toggle", "actToggle"],
    ["p1", "actP1"], ["p5", "actP5"], ["reset", "actReset"], ["hide", "actHide"]]) {
    const btn = controls.querySelector(`[data-act="${act}"]`);
    if (btn) btn.title = d[key];
  }
}

function applyState(s) {
  if (!s) return;
  soundOn = s.sound !== false;
  if (!soundOn) stopAlarm(); // 提示音被关掉时立即静音
  if (s.alarm) alarmSetting = s.alarm;
  animOn = s.anim !== false;
  if (!animOn) stopDeviceAnim();
  if (s.lang && s.lang !== lang) {
    lang = s.lang;
    applyTexts();
  }
  // 输入框没在编辑时才回写，避免打字被覆盖
  if (document.activeElement !== minsInput && s.minutes) {
    minsInput.value = s.minutes;
    if (!running) {
      totalSec = s.minutes * 60;
      if (remainSec > totalSec) remainSec = totalSec;
      if (remainSec === totalSec) render(); // 空闲态跟随新时长
    }
  }
}

// ---- 渲染 ----

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + "." + String(s).padStart(2, "0");
}

function render() {
  digitsEl.textContent = fmt(remainSec);

  const ratio = totalSec > 0 ? remainSec / totalSec : 0;
  const lit = remainSec <= 0 ? 0 : Math.max(1, Math.ceil(ratio * SEGMENTS));
  const blinkLast = running && remainSec <= BLINK_WARN_SEC;

  for (let i = 0; i < SEGMENTS; i++) {
    const on = i < lit;
    segs[i].classList.toggle("on", on);
    segs[i].classList.toggle("warn", on && blinkLast && i === lit - 1);
  }

  lcd.classList.toggle("paused", !running && !finished && remainSec < totalSec);
  lcd.classList.toggle("finished", finished);
}

// ---- 到点铃音 ----
// 上行三音琶音两遍 + 收尾长音，总长约 3 秒；双振荡器（基音+倍频）模拟铃声质感。

function playAlarm() {
  if (!soundOn) return;
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = beepCtx;
    const note = (freq, start, dur, peak) => {
      const t = ctx.currentTime + start;
      for (const [f, g] of [[freq, peak], [freq * 2, peak * 0.3]]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(g, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
    };
    const G5 = 784, C6 = 1047, E6 = 1319;
    const seq = [
      [G5, 0.00, 0.50], [C6, 0.30, 0.50], [E6, 0.60, 0.60],
      [G5, 1.15, 0.50], [C6, 1.45, 0.50], [E6, 1.75, 0.60],
      [C6, 2.30, 1.00],
    ];
    for (const [f, s, dur] of seq) note(f, s, dur, 0.22);
  } catch (e) { /* 无声环境下忽略 */ }
}

// ---- 动态效果 ----

let animCleanupTimer = null;

// playDeviceAnim 播放机身动画（"start"=钟摆轻晃，"finish"=铃声抖动）；
// 关闭动态效果时静默跳过。
function playDeviceAnim(name) {
  if (!animOn) return;
  stopDeviceAnim();
  void device.offsetWidth; // 强制重排，让同一动画可连续触发
  device.classList.add("anim-" + name);
  // 系统“减少动态效果”会让 animation:none 生效，animationend 不触发，这里兜底清理
  animCleanupTimer = setTimeout(stopDeviceAnim, 900);
}

function stopDeviceAnim() {
  device.classList.remove("anim-start", "anim-finish");
  if (animCleanupTimer) {
    clearTimeout(animCleanupTimer);
    animCleanupTimer = null;
  }
}

device.addEventListener("animationend", stopDeviceAnim);

// startAlarm 按设置循环播放铃音：once=一遍；10/30=限定秒数；loop=直到点击停止。
function startAlarm() {
  if (!soundOn) return;
  stopAlarm();
  playAlarm();
  if (alarmSetting === "once") return;
  const limitMs = alarmSetting === "loop" ? Infinity : parseInt(alarmSetting, 10) * 1000;
  const deadline = Date.now() + limitMs;
  alarmTimer = setInterval(() => {
    if (!finished || Date.now() >= deadline) {
      stopAlarm();
      return;
    }
    playDeviceAnim("finish"); // 每轮铃音伴随一次抖动
    playAlarm(); // 一轮约 3.3 秒，间隔略大于一轮保证不重叠
  }, 3400);
}

function stopAlarm() {
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
}

// ---- 计时循环 ----

function tick() {
  if (running) {
    remainSec = (endTs - Date.now()) / 1000;
    if (remainSec <= 0) {
      remainSec = 0;
      running = false;
      finished = true;
      playDeviceAnim("finish"); // 到点：铃声式抖动
      startAlarm();
    }
    render();
  }
  requestAnimationFrame(tick);
}

// ---- 操作 ----

function setMinutes(min) {
  min = Math.min(99, Math.max(1, Math.round(min)));
  totalSec = min * 60;
  remainSec = totalSec;
  running = false;
  finished = false;
  stopAlarm();
  if (document.activeElement !== minsInput) minsInput.value = min;
  ipc("SaveMinutes", min);
  render();
}

function nudge(delta) {
  if (running) return; // 运行中不改时长（与实体机一致）
  setMinutes(Math.round(totalSec / 60) + delta);
}

function commitMinutes() {
  const v = parseInt(minsInput.value, 10);
  if (Number.isFinite(v)) setMinutes(v);
  else minsInput.value = Math.round(totalSec / 60);
}

function toggleRun() {
  if (finished) { reset(); return; }
  if (running) {
    remainSec = Math.max(0, (endTs - Date.now()) / 1000);
    running = false;
  } else {
    if (remainSec <= 0) remainSec = totalSec;
    endTs = Date.now() + remainSec * 1000;
    running = true;
    playDeviceAnim("start"); // 开始计时：钟摆式轻晃
    try { beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  minsInput.readOnly = running; // 运行中锁定时长
  render();
}

function reset() {
  remainSec = totalSec;
  running = false;
  finished = false;
  stopAlarm(); // 到点循环响时，点击/空格/R 停铃
  minsInput.readOnly = false;
  render();
}

// ---- 事件 ----

bar.addEventListener("click", toggleRun);
lcd.addEventListener("click", toggleRun);
lcd.addEventListener("dblclick", reset);

// 滚轮调分钟：累积 delta，每滚过一格（120）调 1 分钟，避免高分辨率滚轮一次跳多格
let wheelAcc = 0;
bar.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (running) return;
  wheelAcc += -e.deltaY;
  if (Math.abs(wheelAcc) >= 120) {
    nudge(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
  }
}, { passive: false });

// 自定义时长输入
minsInput.addEventListener("focus", () => minsInput.select());
minsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Escape") {
    e.preventDefault();
    commitMinutes();
    minsInput.blur();
  }
  e.stopPropagation(); // 输入时不触发全局快捷键
});
minsInput.addEventListener("blur", commitMinutes);

controls.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  switch (btn.dataset.act) {
    case "m5": nudge(-5); break;
    case "m1": nudge(-1); break;
    case "p1": nudge(1); break;
    case "p5": nudge(5); break;
    case "toggle": toggleRun(); break;
    case "reset": reset(); break;
    case "hide": stopAlarm(); ipc("HideToTray"); break;
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target === minsInput) return; // 输入框里不抢按键
  switch (e.key) {
    case " ": e.preventDefault(); toggleRun(); break;
    case "r": case "R": reset(); break;
    case "ArrowUp": e.preventDefault(); nudge(e.shiftKey ? 5 : 1); break;
    case "ArrowDown": e.preventDefault(); nudge(e.shiftKey ? -5 : -1); break;
    case "Escape": stopAlarm(); ipc("HideToTray"); break;
  }
});

// Go 侧状态变化（语言等）→ 统一同步
if (inMyGo && typeof window.mygo.on === "function") {
  window.mygo.on("state", applyState);
}

// 调试：URL 带 #controls（或运行中切到该 hash）时常显控制条，配合 --shot 截图核对顶栏
function applyDebugControls() {
  document.getElementById("device").classList.toggle("always", location.hash.includes("controls"));
}
applyDebugControls();
window.addEventListener("hashchange", applyDebugControls);

// ---- 启动 ----

(async function init() {
  const s = await ipc("LoadSettings");
  if (s && s.minutes) {
    totalSec = remainSec = Math.min(99, Math.max(1, s.minutes)) * 60;
  }
  minsInput.value = Math.round(totalSec / 60);
  minsInput.readOnly = running;
  lang = (s && s.lang) || "zh-CN";
  applyTexts();
  render();
  requestAnimationFrame(tick);
})();
