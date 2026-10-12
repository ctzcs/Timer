// 桌面置顶计时器：无边框透明窗口 + 托盘，仿实体视觉计时器外观。
// 前端为 frontend/ 下的纯静态页面，通过 mygo.call("Timer.xxx") 调用这里绑定的方法；
// 应用级状态（时长/声音/置顶/自启/语言）以这里为唯一事实源，变更后广播 state 事件，
// 托盘菜单勾选、设置窗口与主窗口据此保持一致。
package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

//go:embed all:frontend
var frontendFS embed.FS

//go:embed assets/tray.png
var trayIcon []byte

var langs = map[string]bool{"zh-CN": true, "en": true, "ja": true, "ru": true}

// Prefs 是持久化到 config.json 的用户偏好（开机自启读系统，不落盘）。
type Prefs struct {
	Minutes     int    `json:"minutes"`
	Sound       bool   `json:"sound"`
	AlwaysOnTop bool   `json:"alwaysOnTop"`
	Lang        string `json:"lang"`
}

// UIState 是发给前端的完整状态。
type UIState struct {
	Minutes     int    `json:"minutes"`
	Sound       bool   `json:"sound"`
	AlwaysOnTop bool   `json:"alwaysOnTop"`
	AutoStart   bool   `json:"autoStart"`
	Lang        string `json:"lang"`
}

func defaultPrefs() Prefs { return Prefs{Minutes: 30, Sound: true, AlwaysOnTop: true, Lang: "zh-CN"} }

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
	mu          sync.Mutex
	win         *mygo.Window // 主窗口（计时器）
	settingsWin *mygo.Window // 设置窗口（存在时）
	tray        *mygo.Tray
	menu        *mygo.Menu
	items       map[string]*mygo.MenuItem // 托盘菜单项，重打标签/勾选用
	quitting    bool
	prefs       Prefs
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
	return UIState{p.Minutes, p.Sound, p.AlwaysOnTop, mygo.App.OpenAtLogin(), lang}
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
		Title:         i18n(lang).settings,
		URL:           "/settings.html",
		Width:         340,
		Height:        300,
		DisableResize: true,
	}
	if main != nil {
		opts.Parent = main // 挂在主窗口下，聚焦行为跟随
	}
	sw := mygo.NewWindow(opts)
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
	if !mygo.App.RequestSingleInstanceLock() {
		return // 已有实例在跑，静默退出
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
	//   --set k=v                  外部驱动开关/语言（调试/自动化）
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
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
