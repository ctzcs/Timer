// 桌面置顶计时器：无边框透明窗口 + 托盘，仿实体视觉计时器外观。
// 前端为 frontend/ 下的纯静态页面，通过 mygo.call("Timer.xxx") 调用这里绑定的方法；
// 应用级状态（时长/声音/置顶/自启/语言）以这里为唯一事实源，变更后广播 state 事件，
// 托盘菜单勾选、设置窗口与主窗口据此保持一致。
package main

import (
	"archive/zip"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

const githubAPI = "https://api.github.com/repos/ctzcs/Timer/releases/latest"

// 上次通过 --update 触发的检查时间（unix 毫秒），用于去抖。
var lastAutoCheck int64

//go:embed all:frontend
var frontendFS embed.FS

//go:embed assets/tray.png
var trayIcon []byte

var langs = map[string]bool{"zh-CN": true, "en": true, "ja": true, "ru": true}

// 到点铃声时长：once=响一遍，数字=秒数，loop=持续响直到点击。
var alarmModes = map[string]bool{"once": true, "10": true, "30": true, "loop": true}

// Prefs 是持久化到 config.json 的用户偏好（开机自启读系统，不落盘）。
type Prefs struct {
	Minutes     int    `json:"minutes"`
	Sound       bool   `json:"sound"`
	AlwaysOnTop bool   `json:"alwaysOnTop"`
	Lang        string `json:"lang"`
	Alarm       string `json:"alarm"`
	Anim        bool   `json:"anim"`
}

// UIState 是发给前端的完整状态。
type UIState struct {
	Version     string `json:"version"`
	Minutes     int    `json:"minutes"`
	Sound       bool   `json:"sound"`
	AlwaysOnTop bool   `json:"alwaysOnTop"`
	AutoStart   bool   `json:"autoStart"`
	Lang        string `json:"lang"`
	Alarm       string `json:"alarm"`
	Anim        bool   `json:"anim"`
}

var defaultAnim = true

// UpdateInfo 是检查更新的结果。
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	HasUpdate bool   `json:"hasUpdate"`
	URL       string `json:"url"`
	Message   string `json:"message"` // 检查失败的原因，空表示成功
}

func defaultPrefs() Prefs {
	return Prefs{Minutes: 30, Sound: true, AlwaysOnTop: true, Lang: "zh-CN", Alarm: "loop", Anim: defaultAnim}
}

// stateEvent 把状态推给前端（所有窗口），托盘勾选与页面据此保持一致。
var stateEvent = mygo.NewEvent[UIState]("state")

// ---- 界面文案（托盘/窗口标题）----

type labels struct {
	title     string
	showHide  string
	onTop     string
	sound     string
	autoStart string
	settings  string
	quit      string
}

func i18n(lang string) labels {
	switch lang {
	case "en":
		return labels{"Desktop Timer", "Show / Hide", "Always on Top", "Sound", "Launch at Login", "Settings…", "Quit"}
	case "ja":
		return labels{"デスクトップタイマー", "表示 / 非表示", "最前面に表示", "サウンド", "サインイン時に起動", "設定…", "終了"}
	case "ru":
		return labels{"Таймер", "Показать / скрыть", "Поверх всех окон", "Звук", "Запуск при входе", "Настройки…", "Выход"}
	default:
		return labels{"桌面计时器", "显示 / 隐藏", "窗口置顶", "提示音", "开机自启", "设置…", "退出"}
	}
}

type timerApp struct {
	mu           sync.Mutex
	win          *mygo.Window // 主窗口（计时器）
	settingsWin  *mygo.Window // 设置窗口（存在时）
	tray         *mygo.Tray
	menu         *mygo.Menu
	items        map[string]*mygo.MenuItem // 托盘菜单项，重打标签/勾选用
	quitting     bool
	updateStaged bool // 已下载好新版本，退出后换文件重启
	prefs        Prefs
}

var app timerApp

func (t *timerApp) snapshot() UIState {
	t.mu.Lock()
	p := t.prefs
	t.mu.Unlock()
	lang := p.Lang
	if !langs[lang] {
		lang = "zh-CN"
	}
	alarm := p.Alarm
	if !alarmModes[alarm] {
		alarm = "loop"
	}
	return UIState{appVersion, p.Minutes, p.Sound, p.AlwaysOnTop, mygo.App.OpenAtLogin(), lang, alarm, p.Anim}
}

// syncState 回写托盘菜单文案与勾选、重装快照，并把状态广播给所有窗口。
func (t *timerApp) syncState() {
	s := t.snapshot()
	l := i18n(s.Lang)
	texts := map[string]string{
		"toggle": l.showHide, "ontop": l.onTop, "sound": l.sound,
		"autostart": l.autoStart, "settings": l.settings, "quit": l.quit,
	}
	t.mu.Lock()
	items := t.items
	win, tray, menu := t.win, t.tray, t.menu
	t.mu.Unlock()

	for id, item := range items {
		if item == nil {
			continue
		}
		if txt, ok := texts[id]; ok {
			item.SetLabel(txt)
		}
	}
	if item := items["ontop"]; item != nil {
		item.SetChecked(s.AlwaysOnTop)
	}
	if item := items["sound"]; item != nil {
		item.SetChecked(s.Sound)
	}
	if item := items["autostart"]; item != nil {
		item.SetChecked(s.AutoStart)
	}
	// MyGo 的托盘菜单是安装时的快照，SetChecked/SetLabel 不会自动更新它
	// （UpdateMenuItem 只刷新应用/窗口菜单），必须重装快照，下次弹出才生效。
	if tray != nil && menu != nil {
		tray.SetMenu(menu)
	}
	if win != nil {
		win.SetTitle(l.title)
	}
	if sw := t.settings(); sw != nil {
		sw.SetTitle(l.settings)
	}
	for _, w := range mygo.Windows() {
		if err := stateEvent.Emit(w, s); err != nil {
			log.Printf("emit state: %v", err)
		}
	}
}

func (t *timerApp) settings() *mygo.Window {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.settingsWin
}

func (t *timerApp) persistPrefs() {
	t.mu.Lock()
	p := t.prefs
	t.mu.Unlock()
	if err := writePrefs(p); err != nil {
		log.Printf("save prefs: %v", err)
	}
}

// ---- 绑定给前端的服务（JS 里 mygo.call("Timer.xxx")）----

// LoadSettings 返回完整状态；首次启动给默认值。
func (t *timerApp) LoadSettings() UIState {
	return t.snapshot()
}

// SaveMinutes 保存自定义时长（分钟）。
func (t *timerApp) SaveMinutes(min int) {
	if min < 1 || min > 99 {
		return
	}
	t.mu.Lock()
	t.prefs.Minutes = min
	t.mu.Unlock()
	t.persistPrefs()
	t.syncState()
}

// SetSound 切换提示音。
func (t *timerApp) SetSound(v bool) {
	t.mu.Lock()
	t.prefs.Sound = v
	t.mu.Unlock()
	t.persistPrefs()
	t.syncState()
}

// SetAlwaysOnTop 切换置顶。
func (t *timerApp) SetAlwaysOnTop(v bool) {
	t.mu.Lock()
	win := t.win
	t.mu.Unlock()
	if win == nil {
		return
	}
	win.SetAlwaysOnTop(v)
	t.mu.Lock()
	t.prefs.AlwaysOnTop = v
	t.mu.Unlock()
	t.persistPrefs()
	t.syncState()
}

// SetAutoStart 切换开机自启（Windows：HKCU Run 注册表项）。
func (t *timerApp) SetAutoStart(v bool) {
	if err := mygo.App.SetOpenAtLogin(v); err != nil {
		log.Printf("set open at login: %v", err)
	}
	t.syncState()
}

// SetLang 切换界面语言（zh-CN / en / ja / ru）。
func (t *timerApp) SetLang(lang string) {
	if !langs[lang] {
		return
	}
	t.mu.Lock()
	t.prefs.Lang = lang
	t.mu.Unlock()
	t.persistPrefs()
	t.syncState()
}

// SetAlarm 设置到点铃声时长（once / 10 / 30 / loop）。
func (t *timerApp) SetAlarm(mode string) {
	if !alarmModes[mode] {
		return
	}
	t.mu.Lock()
	t.prefs.Alarm = mode
	t.mu.Unlock()
	t.persistPrefs()
	t.syncState()
}

// SetAnim 开关动态效果。
func (t *timerApp) SetAnim(v bool) {
	t.mu.Lock()
	t.prefs.Anim = v
	t.mu.Unlock()
	t.persistPrefs()
	t.syncState()
}

// HideToTray 隐藏主窗口（托盘仍在）。
func (t *timerApp) HideToTray() {
	t.mu.Lock()
	win := t.win
	t.mu.Unlock()
	if win != nil {
		win.Hide()
	}
}

// Quit 真正退出程序（绕过“隐藏到托盘”的关闭拦截）。
func (t *timerApp) Quit() {
	t.mu.Lock()
	t.quitting = true
	t.mu.Unlock()
	mygo.App.Quit()
}

// ---- 自动更新 ----

// updateNow 检查并应用更新（--update 调试参数与 TIMER_UPDATE_ON_START 自检共用）。
func (t *timerApp) updateNow() {
	info := t.CheckUpdate()
	log.Printf("check update: latest=%s hasUpdate=%v url=%s msg=%q",
		info.Latest, info.HasUpdate, info.URL, info.Message)
	if info.HasUpdate && info.URL != "" {
		if err := t.ApplyUpdate(info.URL); err != nil {
			log.Printf("apply update: %v", err)
		}
	}
}

// CheckUpdate 查询 GitHub 最新 Release 并与当前版本比较。
// 可用环境变量 TIMER_RELEASE_API 覆盖查询地址（测试/镜像）；
// GitHub API 不可用（被限流/拦截，常见 403）时，回退到 releases/latest
// 页面的 302 重定向解析——github.com 的 HTML 比域名 API 稳定得多。
func (t *timerApp) CheckUpdate() UpdateInfo {
	if api := os.Getenv("TIMER_RELEASE_API"); api != "" {
		return t.checkViaAPI(api)
	}
	info := t.checkViaAPI(githubAPI)
	if info.Message == "" {
		return info
	}
	return t.checkViaRedirect()
}

func (t *timerApp) checkViaAPI(api string) UpdateInfo {
	info := UpdateInfo{Current: appVersion}
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, api, nil)
	if err != nil {
		info.Message = err.Error()
		return info
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		info.Message = err.Error()
		return info
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		info.Message = "no published release"
		return info
	case resp.StatusCode != http.StatusOK:
		info.Message = "HTTP " + resp.Status
		return info
	}
	var payload struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		info.Message = err.Error()
		return info
	}
	info.Latest = strings.TrimPrefix(strings.TrimPrefix(payload.TagName, "v"), "V")
	info.HasUpdate = newerVersion(info.Latest, appVersion)
	assetRe := regexp.MustCompile(`^timer-v.+-(windows-amd64)\.zip$`)
	for _, a := range payload.Assets {
		if assetRe.MatchString(a.Name) {
			info.URL = a.BrowserDownloadURL
			break
		}
	}
	if info.HasUpdate && info.URL == "" {
		info.HasUpdate = false
		info.Message = "release has no windows-amd64 zip asset"
	}
	return info
}

// checkViaRedirect 通过 releases/latest 的 302 目标地址（…/releases/tag/vX.Y.Z）
// 解析最新版本号；下载地址按发布包命名规则直接构造。
func (t *timerApp) checkViaRedirect() UpdateInfo {
	info := UpdateInfo{Current: appVersion}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get("https://github.com/ctzcs/Timer/releases/latest")
	if err != nil {
		info.Message = err.Error()
		return info
	}
	defer resp.Body.Close()
	if resp.Request == nil || resp.Request.URL == nil {
		info.Message = "no redirect target"
		return info
	}
	tag := ""
	parts := strings.Split(resp.Request.URL.Path, "/")
	for i, p := range parts {
		if p == "tag" && i+1 < len(parts) {
			tag = parts[i+1]
		}
	}
	if tag == "" {
		info.Message = "no published release"
		return info
	}
	info.Latest = strings.TrimPrefix(strings.TrimPrefix(tag, "v"), "V")
	info.HasUpdate = newerVersion(info.Latest, appVersion)
	if info.HasUpdate {
		info.URL = fmt.Sprintf(
			"https://github.com/ctzcs/Timer/releases/download/v%s/timer-v%s-windows-amd64.zip",
			info.Latest, info.Latest)
	}
	return info
}

// newerVersion 按 major.minor.patch 数值比较 latest 是否比 current 新。
func newerVersion(latest, current string) bool {
	nums := func(v string) [3]int {
		var out [3]int
		v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
		for i, part := range strings.SplitN(v, ".", 3) {
			if i > 2 {
				break
			}
			n := 0
			for _, r := range part {
				if r < '0' || r > '9' {
					break
				}
				n = n*10 + int(r-'0')
			}
			out[i] = n
		}
		return out
	}
	a, b := nums(latest), nums(current)
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

// ApplyUpdate 下载新版 zip、解出 timer.exe 并标记待更新；
// 应用退出后由 swapAndRestart 换文件并重启。
func (t *timerApp) ApplyUpdate(url string) error {
	t.mu.Lock()
	staged := t.updateStaged
	t.mu.Unlock()
	if staged {
		return nil // 防重入：更新已就绪（参数被重复转发时）
	}
	if url == "" {
		return errors.New("empty update url")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Dir(exe)
	zipPath := filepath.Join(dir, "update.zip")
	newExe := filepath.Join(dir, "timer.exe.new")

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %s", resp.Status)
	}
	f, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(zipPath)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	// 从包里解出 timer.exe
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		os.Remove(zipPath)
		return err
	}
	var exeFile *zip.File
	for _, entry := range zr.File {
		if entry.Name == "timer.exe" {
			exeFile = entry
			break
		}
	}
	if exeFile == nil {
		zr.Close()
		os.Remove(zipPath)
		return errors.New("update package missing timer.exe")
	}
	src, err := exeFile.Open()
	if err != nil {
		zr.Close()
		os.Remove(zipPath)
		return err
	}
	dst, err := os.Create(newExe)
	if err != nil {
		src.Close()
		zr.Close()
		os.Remove(zipPath)
		return err
	}
	_, err = io.Copy(dst, src)
	src.Close()
	dst.Close()
	zr.Close()
	os.Remove(zipPath)
	if err != nil {
		os.Remove(newExe)
		return err
	}

	t.mu.Lock()
	t.updateStaged = true
	t.mu.Unlock()
	t.Quit() // 退出后 main 里换文件重启
	return nil
}

func (t *timerApp) updatePending() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.updateStaged
}

// swapAndRestart 在旧进程退出后执行：换文件并启动新版本。
func swapAndRestart() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	dir := filepath.Dir(exe)
	old := filepath.Join(dir, "timer.exe.old")
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		log.Printf("update swap: %v", err)
		return
	}
	if err := os.Rename(filepath.Join(dir, "timer.exe.new"), exe); err != nil {
		log.Printf("update swap: %v", err)
		_ = os.Rename(old, exe) // 回滚
		return
	}
	// 直接拉起新版本。旧进程此刻尚未退出、单实例锁仍在，新实例首次拿锁会失败，
	// 但 main 里的重试会在旧进程退出后接管（实测该时序可靠）。
	// 注意别用 os.StartProcess：ProcAttr 不带 Files 时 Windows 上报 invalid argument。
	cmd := exec.Command(exe)
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		log.Printf("update restart: %v", err)
		return
	}
	_ = cmd.Process.Release()
}

// makeToolWindow 给窗口加 WS_EX_TOOLWINDOW 样式：Windows 保证这类窗口
// 不出现在任务栏和 Alt+Tab（托盘部件的标准做法；MyGo 的 SkipTaskbar 走
// ITaskbarList3::DeleteTab，实测不能稳定覆盖 WebView2 场景）。
func makeToolWindow(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	user32 := syscall.NewLazyDLL("user32.dll")
	get := user32.NewProc("GetWindowLongPtrW")
	set := user32.NewProc("SetWindowLongPtrW")
	const gwlExStyle = ^uintptr(19) // -20
	const wsExToolWindow = 0x00000080
	ex, _, _ := get.Call(hwnd, gwlExStyle)
	set.Call(hwnd, gwlExStyle, ex|wsExToolWindow)
}

// ---- 设置窗口 ----

func (t *timerApp) openSettings() {
	if sw := t.settings(); sw != nil {
		sw.Show()
		sw.Focus()
		return
	}
	t.mu.Lock()
	main := t.win
	lang := t.prefs.Lang
	t.mu.Unlock()

	opts := mygo.WindowOptions{
		Title:          i18n(lang).settings,
		URL:            "/settings.html",
		Width:          380,
		Height:         460,
		DisableResize:  true,
		DisableMinimize: true, // 无任务栏按钮，最小化会“失踪”
		SkipTaskbar:    true,
	}
	if main != nil {
		opts.Parent = main // 挂在主窗口下，聚焦行为跟随
	}
	sw := mygo.NewWindow(opts)
	_ = sw.SetIcon(trayIcon)
	makeToolWindow(sw.NativeHandle())
	t.mu.Lock()
	t.settingsWin = sw
	t.mu.Unlock()
	sw.OnClosed(func() {
		t.mu.Lock()
		t.settingsWin = nil
		t.mu.Unlock()
	})
}

// ---- 偏好读写 ----

func prefsPath() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil || dir == "" {
		return ""
	}
	return filepath.Join(dir, "config.json")
}

func readPrefs() (Prefs, error) {
	p := defaultPrefs()
	path := prefsPath()
	if path == "" {
		return p, os.ErrNotExist
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return defaultPrefs(), err
	}
	if p.Minutes < 1 || p.Minutes > 99 {
		p.Minutes = 30
	}
	if !langs[p.Lang] {
		p.Lang = "zh-CN"
	}
	if !alarmModes[p.Alarm] {
		p.Alarm = "loop"
	}
	// 旧配置文件里没有 anim 字段：区分“缺省”与“明确关闭”，缺省视为开启
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err == nil {
		if _, ok := raw["anim"]; !ok {
			p.Anim = defaultAnim
		}
	}
	return p, nil
}

func writePrefs(p Prefs) error {
	path := prefsPath()
	if path == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// ---- 窗口与托盘 ----

func createWindow(start Prefs) {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title:         i18n(start.Lang).title,
		URL:           "/",
		Width:         560,
		Height:        150,
		Frameless:     true,
		Transparent:   true,
		DisableShadow: true, // 阴影由页面内 CSS 绘制，避免 DWM 矩形阴影穿帮
		AlwaysOnTop:   start.AlwaysOnTop,
		SkipTaskbar:   true,
		DisableResize: true,
		StateKey:      "main", // 自动记忆/恢复窗口位置
	})
	app.mu.Lock()
	app.win = win
	app.mu.Unlock()

	// 双保险：确保任务栏和 Alt+Tab 里都没有图标（只存在于托盘）
	_ = win.SetIcon(trayIcon)
	makeToolWindow(win.NativeHandle())

	// 点关闭 → 隐藏到托盘；托盘“退出”才会真正结束。
	win.OnClose(func(e *mygo.CloseEvent) {
		app.mu.Lock()
		quitting := app.quitting
		app.mu.Unlock()
		if !quitting {
			e.PreventDefault()
			win.Hide()
		}
	})
}

func createTray(start Prefs) {
	l := i18n(start.Lang)
	app.mu.Lock()
	app.items = map[string]*mygo.MenuItem{
		"toggle": {ID: "toggle", Label: l.showHide, Click: func(_ *mygo.MenuItem, _ *mygo.Window) {
			t := &app
			t.mu.Lock()
			win := t.win
			t.mu.Unlock()
			if win == nil {
				return
			}
			if win.IsVisible() {
				win.Hide()
			} else {
				win.Show()
			}
		}},
		"ontop": {ID: "ontop", Label: l.onTop, Type: mygo.MenuItemCheckbox, Checked: start.AlwaysOnTop,
			Click: func(item *mygo.MenuItem, _ *mygo.Window) { app.SetAlwaysOnTop(item.IsChecked()) }},
		"sound": {ID: "sound", Label: l.sound, Type: mygo.MenuItemCheckbox, Checked: start.Sound,
			Click: func(item *mygo.MenuItem, _ *mygo.Window) { app.SetSound(item.IsChecked()) }},
		"autostart": {ID: "autostart", Label: l.autoStart, Type: mygo.MenuItemCheckbox, Checked: mygo.App.OpenAtLogin(),
			Click: func(item *mygo.MenuItem, _ *mygo.Window) { app.SetAutoStart(item.IsChecked()) }},
		"settings": {ID: "settings", Label: l.settings,
			Click: func(_ *mygo.MenuItem, _ *mygo.Window) { app.openSettings() }},
		"quit": {ID: "quit", Label: l.quit, Click: func(_ *mygo.MenuItem, _ *mygo.Window) { app.Quit() }},
	}
	app.mu.Unlock()

	menu := mygo.NewMenu([]*mygo.MenuItem{
		app.items["toggle"],
		mygo.Separator(),
		app.items["ontop"],
		app.items["sound"],
		app.items["autostart"],
		app.items["settings"],
		mygo.Separator(),
		app.items["quit"],
	})
	app.mu.Lock()
	app.menu = menu
	app.mu.Unlock()

	tray, err := mygo.NewTray(mygo.TrayOptions{
		Icon:    trayIcon,
		ToolTip: i18n(start.Lang).title,
		Menu:    menu,
	})
	if err != nil {
		log.Printf("托盘创建失败: %v", err)
		return
	}
	app.mu.Lock()
	app.tray = tray
	app.mu.Unlock()
}

// applySetFlag 处理 --set name=on|off|zh-CN|en|ja|ru 调试参数。
func (t *timerApp) applySetFlag(kv string) {
	name, val, ok := strings.Cut(kv, "=")
	if !ok {
		return
	}
	switch name {
	case "sound":
		t.SetSound(val == "on" || val == "true" || val == "1")
	case "pin":
		t.SetAlwaysOnTop(val == "on" || val == "true" || val == "1")
	case "autostart":
		t.SetAutoStart(val == "on" || val == "true" || val == "1")
	case "lang":
		t.SetLang(val)
	case "alarm":
		t.SetAlarm(val)
	case "anim":
		t.SetAnim(val == "on" || val == "true" || val == "1")
	default:
		log.Printf("未知开关: %s", name)
	}
}

func main() {
	log.SetFlags(log.LstdFlags)

	web, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	mygo.SetFrontend(web)
	mygo.BindAs("Timer", &app) // 绑定全局实例，窗口/偏好/菜单引用共享

	mygo.App.SetName("DesktopTimer")
	// 拿不到单实例锁时稍等重试一次：自动更新后新进程要在旧进程退出、锁释放后接管。
	// 注意 RequestSingleInstanceLock 失败即向第一实例转发参数，不能反复重试。
	locked := mygo.App.RequestSingleInstanceLock()
	if !locked {
		time.Sleep(1500 * time.Millisecond)
		locked = mygo.App.RequestSingleInstanceLock()
	}
	if !locked {
		return // 已有实例在跑，静默退出
	}

	// 清理上次自动更新遗留的旧文件。若旧进程尚未完全退出（镜像文件仍被占用），
	// 删除会 Access denied——后台重试最多约 1 分钟，旧进程退出后即可删掉。
	// （注意：正在运行的实例自己就运行在 .old 镜像上时，文件无法删除，属正常。）
	if exe, err := os.Executable(); err == nil {
		old := filepath.Join(filepath.Dir(exe), "timer.exe.old")
		go func() {
			for i := 0; i < 30; i++ {
				err := os.Remove(old)
				if err == nil || os.IsNotExist(err) {
					return
				}
				time.Sleep(2 * time.Second)
			}
		}()
	}

	start, err := readPrefs()
	if err != nil && !os.IsNotExist(err) {
		log.Printf("read prefs: %v", err)
	}
	if err != nil {
		start = defaultPrefs()
	}
	app.mu.Lock()
	app.prefs = start
	app.mu.Unlock()

	// 第二实例把参数转发给第一实例后退出：
	//   --settings                 打开设置窗口
	//   --controls                 顶栏常显（调试）
	//   --update                   检查并应用更新（调试/自动化）
	//   --set k=v                  外部驱动开关/语言/铃声（调试/自动化）
	//   --shot <路径>              截取主窗口页面为 PNG
	//   --shot-settings <路径>     截取设置窗口页面为 PNG
	// 不带参数 = 把计时器叫到前台。
	mygo.App.OnSecondInstance(func(args []string, _ string) {
		app.mu.Lock()
		win := app.win
		app.mu.Unlock()
		if win == nil {
			return
		}
		for i, a := range args {
			switch {
			case a == "--settings":
				app.openSettings()
			case a == "--controls":
				_ = win.Page().LoadURL("/#controls")
			case a == "--update":
				// 去抖：参数转发偶发重复，且 GitHub API 有速率限制
				if now := time.Now().UnixMilli(); now-atomic.LoadInt64(&lastAutoCheck) < 10_000 {
					break
				}
				atomic.StoreInt64(&lastAutoCheck, time.Now().UnixMilli())
				go app.updateNow()
			case a == "--set" && i+1 < len(args):
				app.applySetFlag(args[i+1])
			case a == "--shot" && i+1 < len(args):
				time.Sleep(500 * time.Millisecond) // 等页面按需重载
				if png, err := win.CapturePage(); err != nil {
					log.Printf("capture: %v", err)
				} else if err := os.WriteFile(args[i+1], png, 0o644); err != nil {
					log.Printf("write shot: %v", err)
				}
			case a == "--shot-settings" && i+1 < len(args):
				time.Sleep(500 * time.Millisecond)
				if sw := app.settings(); sw == nil {
					log.Printf("设置窗口未打开")
				} else if png, err := sw.CapturePage(); err != nil {
					log.Printf("capture settings: %v", err)
				} else if err := os.WriteFile(args[i+1], png, 0o644); err != nil {
					log.Printf("write shot: %v", err)
				}
			}
		}
		win.Show()
	})

	mygo.App.WhenReady(func() {
		createWindow(start)
		createTray(start)
		app.syncState() // 初始状态：托盘文案/勾选 + 推给前端，页面就绪后送达
		// 调试/测试：启动即检查更新（配合 TIMER_RELEASE_API 假更新源）
		if os.Getenv("TIMER_UPDATE_ON_START") == "1" {
			go app.updateNow()
		}
	})
	err = mygo.App.Run()
	// 正常退出后若有待安装的更新：换文件并重启新版本
	if err == nil && app.updatePending() {
		swapAndRestart()
	}
	if err != nil {
		log.Fatal(err)
	}
}
