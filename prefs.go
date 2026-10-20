// 用户偏好持久化：config.json 读写 + 结构版本迁移。
//
// 兼容性约定（升级配置结构时必须遵守）：
//   - 只增不删：新字段带 json 标签追加，旧字段保留语义不改名；
//   - 版本迁移：schemaVersion 递增并在 migrations 注册迁移函数，旧配置逐级升级；
//   - 双向容忍：未知字段反序列化时忽略（旧版应用读新配置不报错），
//     缺失字段从 defaultPrefs 拿默认值；
//   - 坏文件保护：JSON 解析失败先备份成 .bak 再落默认值，不直接覆盖。
package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

// schemaVersion 是 config.json 的结构版本，与 appVersion 无关。
// 改配置结构时 +1，并在 migrations 里注册对应迁移函数。
const schemaVersion = 2

// 计时模式：单次倒计时 / 循环作息。
const (
	modeCountdown = "countdown"
	modeCycle     = "cycle"
)

// 课表时段类型：工作休息循环 / 整段休息（午休等）。
const (
	ruleCycle = "cycle"
	ruleBreak = "break"
)

var langs = map[string]bool{"zh-CN": true, "en": true, "ja": true, "ru": true}

// 到点铃声时长：once=响一遍，数字=秒数，loop=持续响直到点击。
var alarmModes = map[string]bool{"once": true, "10": true, "30": true, "loop": true}

var cycleModes = map[string]bool{modeCountdown: true, modeCycle: true}

var ruleTypes = map[string]bool{ruleCycle: true, ruleBreak: true}

var defaultAnim = true
var defaultCycleAuto = true

// CycleRule 是课表里的一个时段，每天重复生效。
type CycleRule struct {
	Start string `json:"start"` // HH:MM
	End   string `json:"end"`   // HH:MM（同日，必须晚于 Start）
	Type  string `json:"type"`  // ruleCycle / ruleBreak
}

// Prefs 是持久化到 config.json 的用户偏好（开机自启读系统，不落盘）。
type Prefs struct {
	Version    int         `json:"version"`
	Minutes    int         `json:"minutes"`
	Sound      bool        `json:"sound"`
	AlwaysOnTop bool       `json:"alwaysOnTop"`
	Lang       string      `json:"lang"`
	Alarm      string      `json:"alarm"`
	Anim       bool        `json:"anim"`
	Mode       string      `json:"mode"`
	CycleWork  int         `json:"cycleWork"` // 循环段内工作时长（分钟）
	CycleRest  int         `json:"cycleRest"` // 循环段内休息时长（分钟）
	CycleLongEvery int     `json:"cycleLongEvery"` // 每工作 N 轮安排一次长休息，0=不启用
	CycleLongRest  int     `json:"cycleLongRest"`  // 长休息时长（分钟）
	CycleAuto  bool        `json:"cycleAuto"` // 相位结束自动进入下一段
	Schedule   []CycleRule `json:"schedule"`  // 每日时间表，顺序即用户排列（行可拖动调整）
}

func defaultPrefs() Prefs {
	return Prefs{
		Version:     schemaVersion,
		Minutes:     30,
		Sound:       true,
		AlwaysOnTop: true,
		Lang:        "zh-CN",
		Alarm:       "loop",
		Anim:        defaultAnim,
		Mode:        modeCountdown,
		CycleWork:   45,
		CycleRest:   10,
		CycleLongEvery: 0, // 默认不启用，升级用户行为不变
		CycleLongRest:  15,
		CycleAuto:   defaultCycleAuto,
	}
}

// migrations 按目标版本注册迁移函数。新结构版本时：schemaVersion+1 并注册
// migrateVNtoVN+1，老配置启动时自动逐级升级，已落盘的用户数据不丢。
var migrations = map[int]func(*Prefs){
	1: migrateV0toV1,
	2: migrateV1toV2,
}

// migrateV0toV1：0.1.x 旧格式（无 version 字段）→ v1（新增循环作息字段）。
// 新字段在解析时已从 defaultPrefs 拿到默认值，这里无数据需要变换，
// 保留函数作为迁移链的起点示例。
func migrateV0toV1(_ *Prefs) {}

// migrateV1toV2：0.2.0 的 v1 → v2（新增长休息字段）。
// CycleLongEvery 默认 0（不启用），升级用户的工作/休息节奏保持不变。
func migrateV1toV2(_ *Prefs) {}

// parsePrefs 解析并规范化配置字节流：跑迁移链到当前版本，再做钳位与白名单校验。
// 任何坏值都以默认值兜底，绝不让应用起不来。解析彻底失败返回错误，由调用方备份原文件。
func parsePrefs(data []byte) (Prefs, error) {
	p := defaultPrefs()
	if err := json.Unmarshal(data, &p); err != nil {
		return defaultPrefs(), err
	}
	for v := p.Version; v < schemaVersion; v++ {
		if m, ok := migrations[v+1]; ok {
			m(&p)
		}
	}
	p.Version = schemaVersion

	// 旧配置文件里可能没有布尔开关字段：区分“缺省”与“明确关闭”，缺省视为开启
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err == nil {
		if _, ok := raw["anim"]; !ok {
			p.Anim = defaultAnim
		}
		if _, ok := raw["cycleAuto"]; !ok {
			p.CycleAuto = defaultCycleAuto
		}
	}

	sanitizePrefs(&p)
	return p, nil
}

// sanitizePrefs 原地钳位/纠偏：白名单外的值回默认，数值出界回默认，课表剔除非法条目。
func sanitizePrefs(p *Prefs) {
	if p.Minutes < 1 || p.Minutes > 99 {
		p.Minutes = 30
	}
	if !langs[p.Lang] {
		p.Lang = "zh-CN"
	}
	if !alarmModes[p.Alarm] {
		p.Alarm = "loop"
	}
	if !cycleModes[p.Mode] {
		p.Mode = modeCountdown
	}
	if p.CycleWork < 1 || p.CycleWork > 99 {
		p.CycleWork = 45
	}
	if p.CycleRest < 1 || p.CycleRest > 99 {
		p.CycleRest = 10
	}
	if p.CycleLongEvery < 0 || p.CycleLongEvery > 99 {
		p.CycleLongEvery = 0
	}
	if p.CycleLongRest < 1 || p.CycleLongRest > 99 {
		p.CycleLongRest = 15
	}
	p.Schedule = sanitizeSchedule(p.Schedule)
}

// sanitizeSchedule 校验课表条目：时间格式非法、起止颠倒、类型未知的丢弃。
// 保持用户在设置里排的顺序（行可拖动调整顺序）；重叠时段按先开始者优先，
// 计时引擎（timer.js scheduleAt）在使用侧自行按开始时间排序。
func sanitizeSchedule(rules []CycleRule) []CycleRule {
	out := make([]CycleRule, 0, len(rules))
	for _, r := range rules {
		if !ruleTypes[r.Type] || !validHM(r.Start) || !validHM(r.End) || r.End <= r.Start {
			continue
		}
		out = append(out, r)
	}
	return out
}

// validHM 严格校验 "HH:MM"（HH 0–23，MM 0–59）。定长零填充格式下
// 字典序即时间序，课表排序与“起止颠倒”判断都直接用字符串比较。
func validHM(s string) bool {
	if len(s) != 5 || s[2] != ':' {
		return false
	}
	h, ok1 := atoi2(s[0:2])
	m, ok2 := atoi2(s[3:5])
	return ok1 && ok2 && h < 24 && m < 60
}

func atoi2(s string) (int, bool) {
	if s[0] < '0' || s[0] > '9' || s[1] < '0' || s[1] > '9' {
		return 0, false
	}
	return int(s[0]-'0')*10 + int(s[1]-'0'), true
}

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
	parsed, err := parsePrefs(data)
	if err != nil {
		// 坏文件先备份再回默认，避免下次写盘把可能可抢救的数据覆盖掉
		_ = os.Rename(path, path+".bak")
		return defaultPrefs(), err
	}
	return parsed, nil
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
