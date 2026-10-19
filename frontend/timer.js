// 计时逻辑：基于时间戳差值（不靠 tick 累加），系统休眠/节流后仍准确。
// 两种模式：
//   countdown  单次倒计时（经典模式）
//   cycle      循环作息：按用户配置的每日课表（钟点锚定）在 工作/休息 间切换，
//              相位边界由 scheduleAt(t) 从课表纯函数推导，暂停/重启后自动对齐。
// 窗口操作（隐藏）与偏好持久化走 mygo.call("Timer.xxx")；
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
const phaseEl = document.getElementById("phase");

// 段元素
const segs = [];
for (let i = 0; i < SEGMENTS; i++) {
  const s = document.createElement("div");
  s.className = "seg";
  bar.appendChild(s);
  segs.push(s);
}

// ---- 状态 ----

let totalSec = 30 * 60;   // 设定时长（循环模式=当前相位的全长）
let remainSec = totalSec; // 剩余秒（暂停/未开始时等于当前值）
let endTs = 0;            // 运行中的结束时间戳（ms）
let running = false;
let finished = false;
let mode = "countdown";   // countdown / cycle
let phase = "idle";       // 循环模式当前相位：idle / work / rest / done
let cycleWork = 45;       // 循环段内工作时长（分）
let cycleRest = 10;       // 循环段内休息时长（分）
let cycleAuto = true;     // 相位结束自动进入下一段
let schedule = [];        // 每日课表 [{start,end,type}]（Go 侧已排序校验）
let cycleOrigin = 0;      // 空课表自由循环的起点（ms）
let soundOn = true;
let lang = "zh-CN";
let alarmSetting = "loop"; // once / 10 / 30 / loop
let alarmTimer = null;     // 循环响的定时器
let animOn = true;         // 动态效果开关
let beepCtx = null;

// ---- MyGo IPC（带浏览器降级） ----

const inMyGo = typeof window.mygo !== "undefined" && !!window.mygo.call;

function lsDefaults() {
  return { minutes: 30, sound: true, alwaysOnTop: true, autoStart: false, lang: "zh-CN",
    mode: "countdown", cycleWork: 45, cycleRest: 10, cycleAuto: true, schedule: [] };
}

function lsLoad() {
  try { return JSON.parse(localStorage.getItem("timer-state")) || lsDefaults(); }
  catch { return lsDefaults(); }
}

async function ipc(method, ...args) {
  if (inMyGo) {
    try { return await window.mygo.call("Timer." + method, ...args); }
    catch (e) { console.error("ipc failed:", method, e); }
    return;
  }
  // 浏览器调试降级
  if (method === "LoadSettings") return lsLoad();
  const s = lsLoad();
  if (method === "SaveMinutes") s.minutes = args[0];
  else if (method === "SetMode") s.mode = args[0];
  else if (method === "SaveCycle") { s.cycleWork = args[0]; s.cycleRest = args[1]; s.cycleAuto = args[2]; }
  else if (method === "SaveSchedule") s.schedule = args[0];
  else return;
  localStorage.setItem("timer-state", JSON.stringify(s));
}

// ---- 课表引擎（纯函数） ----

// tsOfDay 返回今天指定分钟（当日 0 点起算）的时间戳。
function tsOfDay(min) {
  const d = new Date();
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return d.getTime();
}

function hmToMin(hm) {
  return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
}

// scheduleAt 计算 t 时刻课表所在的相位：{phase:"work"|"rest"|"done", endTs}。
// 课表为空时退化为自由循环（从 cycleOrigin 起 工作/休息 交替）。
// 钟点锚定：相位边界都来自课表钟点，暂停/重启后按当下时刻重新对齐。
// "rest" 同时覆盖时段空档（等待下一段开始的待命时间）。
function scheduleAt(t) {
  const w = cycleWork * 60000, cyc = w + cycleRest * 60000;
  if (!schedule.length) {
    if (!cycleOrigin || t < cycleOrigin) return null;
    const pos = (t - cycleOrigin) % cyc;
    return { phase: pos < w ? "work" : "rest", endTs: t - pos + (pos < w ? w : cyc) };
  }
  const dayStart = tsOfDay(0);
  const rel = t - dayStart; // 当天经过的毫秒
  let nextStart = null;
  for (const r of schedule) {
    const s = hmToMin(r.start) * 60000, e = hmToMin(r.end) * 60000;
    if (rel < s) { nextStart = s; break; } // 课表按开始时间排序，第一条未到的就是下一段
    if (rel >= e) continue;
    if (r.type === "break") return { phase: "rest", endTs: dayStart + e };
    // 循环段：段内按 工作/休息 周期切分，相位终点取周期点与段尾较早者
    const pos = (rel - s) % cyc;
    const phaseEnd = rel - pos + (pos < w ? w : cyc);
    return { phase: pos < w ? "work" : "rest", endTs: dayStart + Math.min(phaseEnd, e) };
  }
  if (nextStart !== null) return { phase: "rest", endTs: dayStart + nextStart };
  return { phase: "done", endTs: 0 }; // 今日时段全部结束
}

// joinPhase 从 now 起加入某相位：全长按「到相位终点」计，段条从满格开始消耗。
function joinPhase(slot, now) {
  phase = slot.phase;
  endTs = slot.endTs;
  totalSec = Math.max(1, (slot.endTs - now) / 1000);
  remainSec = totalSec;
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
    ["p1", "actP1"], ["p5", "actP5"], ["reset", "actReset"], ["hide", "actHide"],
    ["skip", "actSkip"], ["mode", "actMode"]]) {
    const btn = controls.querySelector(`[data-act="${act}"]`);
    if (btn) btn.title = d[key];
  }
}

// updateControlsMode 按模式切换控制条布局：循环模式隐藏时长/±，显示跳过。
function updateControlsMode() {
  controls.classList.toggle("cycle", mode === "cycle");
  const modeBtn = controls.querySelector('[data-act="mode"]');
  if (modeBtn) modeBtn.textContent = mode === "countdown" ? "∞" : "1×";
}

function applyState(s) {
  if (!s) return;
  soundOn = s.sound !== false;
  if (!soundOn) stopAlarm(); // 提示音被关掉时立即静音
  if (s.alarm) alarmSetting = s.alarm;
  animOn = s.anim !== false;
  if (!animOn) stopDeviceAnim();

  // 模式切换（含外部 --set 触发）：停掉当前计时回到新模式待机态
  const newMode = s.mode === "cycle" ? "cycle" : "countdown";
  if (newMode !== mode) {
    mode = newMode;
    running = false;
    finished = false;
    phase = "idle";
    totalSec = remainSec = 0;
    endTs = cycleOrigin = 0;
    stopAlarm();
    minsInput.readOnly = false;
  }

  // 输入框没在编辑时才回写，避免打字被覆盖（仅倒计时模式有意义）
  if (mode === "countdown" && document.activeElement !== minsInput && s.minutes) {
    minsInput.value = s.minutes;
    if (!running) {
      totalSec = s.minutes * 60;
      if (remainSec > totalSec) remainSec = totalSec;
      if (remainSec === totalSec) render(); // 空闲态跟随新时长
    }
  }

  cycleWork = s.cycleWork > 0 ? s.cycleWork : cycleWork;
  cycleRest = s.cycleRest > 0 ? s.cycleRest : cycleRest;
  cycleAuto = s.cycleAuto !== false;
  schedule = Array.isArray(s.schedule) ? s.schedule : [];

  if (s.lang && s.lang !== lang) {
    lang = s.lang;
    applyTexts();
  }
  updateControlsMode();
  render();
}

// ---- 渲染 ----

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  // ≥100 分钟（长午休等）切换成「时.分」，如 1.30；七段码屏放不下 HH:MM:SS
  if (sec >= 100 * 60) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h + "." + String(m).padStart(2, "0");
  }
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
  bar.classList.toggle("rest", mode === "cycle" && phase === "rest");

  lcd.classList.toggle("paused", !running && !finished && remainSec < totalSec);
  lcd.classList.toggle("finished", finished);

  // 相位徽标：循环模式显示 工作/休息/今日完成
  let badge = "";
  if (mode === "cycle") {
    const d = window.TimerI18N.pick(lang);
    if (finished && phase === "done") badge = d.phaseDone;
    else if (running || finished || (remainSec > 0 && remainSec < totalSec)) {
      badge = phase === "work" ? d.phaseWork : d.phaseRest;
    }
  }
  phaseEl.textContent = badge;
  lcd.classList.toggle("phased", !!badge);
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
  // 兜底清理（正常由 animationend 移除动画类）
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
      if (mode === "cycle") {
        cyclePhaseEnd();
      } else {
        running = false;
        finished = true;
        playDeviceAnim("finish"); // 到点：铃声式抖动
        startAlarm();
      }
    }
    render();
  }
  requestAnimationFrame(tick);
}

// ---- 循环作息 ----

// cyclePhaseEnd 一个相位走完：按课表进下一段（自动），或响铃等待确认（手动）。
function cyclePhaseEnd() {
  const now = Date.now();
  const slot = scheduleAt(now);
  if (!slot || slot.phase === "done" || slot.endTs <= now) {
    dayComplete();
    return;
  }
  if (cycleAuto) {
    // 上下课铃：单响一声随即自动进入下一段。
    // 不走铃声循环设置——下一段已经开始，持续响铃会盖过它。
    playDeviceAnim("finish");
    playAlarm();
    joinPhase(slot, now);
  } else {
    running = false;
    finished = true; // 等待点击确认；点击后进入课表的当前相位
    playDeviceAnim("finish");
    startAlarm();
  }
}

function dayComplete() {
  running = false;
  finished = true;
  phase = "done";
  remainSec = 0; // 收工显示干净的 00.00（跳过触发时残留上一步余数）
  playDeviceAnim("finish");
  startAlarm(); // 今日收工按铃声设置响
  render();
}

// advanceToSchedule 手动确认（或跳过等待态）后进入课表当前相位。
function advanceToSchedule() {
  stopAlarm();
  const now = Date.now();
  const slot = scheduleAt(now);
  finished = false;
  if (!slot || slot.phase === "done") {
    dayComplete();
    return;
  }
  joinPhase(slot, now);
  running = true;
  playDeviceAnim("start");
  render();
}

// cycleStart 开始/恢复循环。暂停恢复优先尊重当前相位（含跳过进来的未来时段）：
// 相位计划终点还没过去就继续走；已被课表走过头才按当下时刻重新对齐——
// 钟点锚定，暂停期间课表照走。
function cycleStart() {
  const now = Date.now();
  if (!schedule.length && (phase === "idle" || phase === "done")) {
    cycleOrigin = now; // 空课表自由循环：从这次按下开始起算
  }
  if (endTs > now) { // 暂停恢复，相位未过期
    remainSec = Math.max(0, (endTs - now) / 1000);
    running = true;
    playDeviceAnim("start");
    return;
  }
  const slot = scheduleAt(now);
  if (!slot) return;
  if (slot.phase === "done") {
    dayComplete(); // 已过今日全部时段还按开始 → 今日完成
    return;
  }
  joinPhase(slot, now);
  running = true;
  playDeviceAnim("start");
}

// skipPhase 跳过当前相位：立即进入下一段，下一段仍按原计划钟点结束。
function skipPhase() {
  if (mode !== "cycle") return;
  if (finished) {
    if (phase === "done") reset();
    else advanceToSchedule();
    return;
  }
  if (!running && remainSec >= totalSec) return; // 未开始，无事可跳
  stopAlarm();
  const now = Date.now();
  // 目标：当前相位计划终点之后的相位（暂停时终点仍是 endTs）
  let t = Math.max(running ? endTs : now + remainSec * 1000, now + 1);
  let slot = scheduleAt(t);
  // 暂停越过若干时段时逐段快进，直到找到一个终点还没过去的相位
  for (let i = 0; slot && slot.phase !== "done" && slot.endTs <= now && i < 500; i++) {
    t = slot.endTs + 1;
    slot = scheduleAt(t);
  }
  finished = false;
  if (!slot || slot.phase === "done") {
    dayComplete();
    return;
  }
  joinPhase(slot, now);
  running = true;
  playDeviceAnim("start");
  render();
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
  if (running || mode === "cycle") return; // 运行中不改时长（与实体机一致）；循环模式无时长概念
  setMinutes(Math.round(totalSec / 60) + delta);
}

function commitMinutes() {
  const v = parseInt(minsInput.value, 10);
  if (Number.isFinite(v)) setMinutes(v);
  else minsInput.value = Math.round(totalSec / 60);
}

function toggleRun() {
  if (mode === "cycle") {
    if (finished) {
      if (phase === "done") reset();
      else advanceToSchedule(); // 手动确认进入下一段
    } else if (running) {
      remainSec = Math.max(0, (endTs - Date.now()) / 1000);
      running = false;
      render();
    } else {
      cycleStart();
      render();
    }
    try { beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    return;
  }
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
  stopAlarm(); // 到点循环响时，点击/空格/R 停铃
  if (mode === "cycle") {
    running = false;
    finished = false;
    phase = "idle";
    totalSec = remainSec = 0;
    endTs = cycleOrigin = 0;
    render();
    return;
  }
  remainSec = totalSec;
  running = false;
  finished = false;
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
  if (running || mode === "cycle") return;
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
    case "mode": ipc("SetMode", mode === "countdown" ? "cycle" : "countdown"); break;
    case "skip": skipPhase(); break;
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target === minsInput) return; // 输入框里不抢按键
  switch (e.key) {
    case " ": e.preventDefault(); toggleRun(); break;
    case "r": case "R": reset(); break;
    case "s": case "S": skipPhase(); break;
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
  mode = s && s.mode === "cycle" ? "cycle" : "countdown";
  cycleWork = s && s.cycleWork > 0 ? s.cycleWork : 45;
  cycleRest = s && s.cycleRest > 0 ? s.cycleRest : 10;
  cycleAuto = !s || s.cycleAuto !== false;
  schedule = s && Array.isArray(s.schedule) ? s.schedule : [];
  if (mode === "countdown" && s && s.minutes) {
    totalSec = remainSec = Math.min(99, Math.max(1, s.minutes)) * 60;
  } else if (mode === "cycle") {
    totalSec = remainSec = 0;
  }
  minsInput.value = s && s.minutes ? s.minutes : Math.round(totalSec / 60);
  minsInput.readOnly = running;
  lang = (s && s.lang) || "zh-CN";
  applyTexts();
  updateControlsMode();
  render();
  requestAnimationFrame(tick);
})();
