package main

import (
	"encoding/json"
	"testing"
)

func TestParseLegacyV0Prefs(t *testing.T) {
	// 0.1.x 的真实旧格式：没有 version、mode、cycle、schedule 字段
	data := []byte(`{
	  "minutes": 25,
	  "sound": false,
	  "alwaysOnTop": true,
	  "lang": "ja",
	  "alarm": "30"
	}`)
	p, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("legacy parse: %v", err)
	}
	if p.Version != schemaVersion {
		t.Errorf("Version = %d, want %d", p.Version, schemaVersion)
	}
	if p.Minutes != 25 || p.Sound || p.Lang != "ja" || p.Alarm != "30" {
		t.Errorf("旧字段被改动: %+v", p)
	}
	// 新字段拿到默认值
	if p.Mode != modeCountdown || p.CycleWork != 45 || p.CycleRest != 10 || !p.CycleAuto || len(p.Schedule) != 0 {
		t.Errorf("v0→v1 默认值不对: %+v", p)
	}
	if p.CycleLongEvery != 0 || p.CycleLongRest != 15 {
		t.Errorf("长休息默认值不对: %+v", p)
	}
}

func TestParseV1MigratesToV2(t *testing.T) {
	// 0.2.0 写出的 v1 配置：有 version=1，无长休息字段
	data := []byte(`{"version": 1, "minutes": 45, "mode": "cycle", "cycleWork": 45, "cycleRest": 10, "cycleAuto": true}`)
	p, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.Version != schemaVersion {
		t.Errorf("Version = %d, want %d", p.Version, schemaVersion)
	}
	// 长休息默认关闭，升级用户的节奏不变
	if p.CycleLongEvery != 0 || p.CycleLongRest != 15 {
		t.Errorf("v1→v2 默认值不对: %+v", p)
	}
	if p.Mode != modeCycle || p.CycleWork != 45 {
		t.Errorf("原有字段被改动: %+v", p)
	}
}

func TestParseClampsBadValues(t *testing.T) {
	data := []byte(`{
	  "minutes": 500,
	  "lang": "xx",
	  "alarm": "nope",
	  "mode": "banana",
	  "cycleWork": 0,
	  "cycleRest": 1000,
	  "cycleLongEvery": -5,
	  "cycleLongRest": 1000,
	  "cycleAuto": false,
	  "anim": false
	}`)
	p, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.Minutes != 30 || p.Lang != "zh-CN" || p.Alarm != "loop" {
		t.Errorf("基础钳位失败: %+v", p)
	}
	if p.Mode != modeCountdown || p.CycleWork != 45 || p.CycleRest != 10 {
		t.Errorf("循环参数钳位失败: %+v", p)
	}
	if p.CycleLongEvery != 0 || p.CycleLongRest != 15 {
		t.Errorf("长休息钳位失败: %+v", p)
	}
	// 明确写了 false 的要保留
	if p.CycleAuto || p.Anim {
		t.Errorf("明确关闭被覆盖成开启: %+v", p)
	}
}

func TestParseMissingBoolDefaultsOn(t *testing.T) {
	data := []byte(`{"minutes": 10, "anim": true}`)
	p, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !p.Anim || !p.CycleAuto {
		t.Errorf("缺省开关应为开启: %+v", p)
	}
}

func TestParseToleratesUnknownFields(t *testing.T) {
	// 未来版本写出的字段，旧版应用读到时应忽略而不报错
	data := []byte(`{"minutes": 15, "futureField": {"a": 1}, "schedule": [], "version": 99}`)
	p, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.Minutes != 15 {
		t.Errorf("Minutes = %d, want 15", p.Minutes)
	}
}

func TestParseScheduleValidation(t *testing.T) {
	data := []byte(`{
	  "schedule": [
	    {"start": "13:30", "end": "18:30", "type": "cycle"},
	    {"start": "12:00", "end": "13:30", "type": "break"},
	    {"start": "8:00",  "end": "09:00", "type": "cycle"},
	    {"start": "25:00", "end": "26:00", "type": "cycle"},
	    {"start": "09:00", "end": "09:00", "type": "cycle"},
	    {"start": "10:00", "end": "11:00", "type": "lunch"},
	    {"start": "xx:00", "end": "11:00", "type": "cycle"}
	  ]
	}`)
	p, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := p.Schedule
	if len(got) != 2 {
		t.Fatalf("保留 %d 条, want 2: %+v", len(got), got)
	}
	// 顺序保持用户排列（不再强制按开始时间排序），非法条目被剔除
	if got[0].Start != "13:30" || got[1].Start != "12:00" {
		t.Errorf("顺序被改写: %+v", got)
	}
	if got[0].Type != ruleCycle || got[1].Type != ruleBreak {
		t.Errorf("类型错误: %+v", got)
	}
}

func TestValidHM(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"00:00", true}, {"23:59", true}, {"09:05", true},
		{"24:00", false}, {"7:30", false}, {"07:60", false},
		{"", false}, {"0700", false}, {"07:0", false}, {"ab:cd", false},
	}
	for _, c := range cases {
		if got := validHM(c.in); got != c.want {
			t.Errorf("validHM(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRoundTripKeepsSchedule(t *testing.T) {
	p := defaultPrefs()
	p.Mode = modeCycle
	p.Schedule = []CycleRule{{"09:00", "12:00", ruleCycle}, {"12:00", "13:30", ruleBreak}}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	back, err := parsePrefs(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if back.Mode != modeCycle || len(back.Schedule) != 2 ||
		back.Schedule[0].Start != "09:00" || back.Schedule[1].Type != ruleBreak {
		t.Errorf("round trip 丢数据: %+v", back)
	}
}

func TestParseBrokenJSONFails(t *testing.T) {
	if _, err := parsePrefs([]byte("{not json")); err == nil {
		t.Error("坏 JSON 应返回错误（由调用方备份原文件）")
	}
}
