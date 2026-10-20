# Always-on-Top Desktop Timer

[中文说明](README.zh-CN.md)

A Windows desktop widget styled after physical visual timers: a white rounded body floats on the desktop, a 30-segment bar on the left goes out over time, and a seven-segment LCD on the right shows `min.sec`. UI languages: 中文 / English / 日本語 / Русский.

Built on [MyGo](https://github.com/egoist/mygo) (Go + system WebView2). Pure Go with no cgo; the release build is a single ~9 MB `timer.exe`, with the frontend embedded as plain static HTML/CSS/JS.

![Preview](assets/preview.png)

![Hover bar](assets/preview-controls.png)

## Features by layer

- **Top bar (appears on hover, high-frequency actions)**: mode toggle (∞/1×), custom duration input, ±1/±5 minutes, start/pause, skip phase (cycle mode), reset, hide to tray
- **Tray (low-frequency toggles + entry point)**: show/hide, always on top, sound, launch at login, Settings…
- **Settings window** (opened from the tray's "Settings…"): two-pane layout with a sidebar — **General** (language, alarm duration, sound, animations, always on top, launch at login, software updates with one-click check → download → auto-swap & restart) and **Timetable** (timer mode, work/break lengths, daily timetable editor)

![Settings](assets/preview-settings.png)

### Daily cycle mode (∞)

Like a school timetable: in Settings → **Timetable** you lay out your own day as time slots — **cycle** slots alternate work/break (45 + 10 min by default, both configurable), **break** slots are plain rest (lunch, a nap, anything). Bells ring at clock times, not at "N minutes after you started":

- Optional **long break**: after every N work rounds inside a cycle slot, the following break is a longer one (e.g. 15 min after every 4 rounds; 0 = off)

- Click start at any time and the timer joins the slot in progress (09:20 start → 25 minutes left of the 09:00 block). Restart the app mid-day and it picks up where the day is
- Gaps between slots count down as "break" until the next slot begins; starting after the last slot ends the day with a "day complete" chime
- Rest phases light the segment bar green; the LCD badge shows work / break / day complete; `»` or `S` skips to the next phase (it still ends at its scheduled clock time)
- With no slots configured the mode degrades to an endless work/break loop until reset
- Timetable rows have drag handles (⋮⋮) and keep your arrangement; overlapping slots resolve to the earlier-starting one
- Auto-advance (on by default) rings one chime and moves on; turn it off to require a click after each phase
- The timetable is stored in `config.json` with a schema version, so it survives app upgrades

All three layers share a single piece of state (Go is the single source of truth + `state` event broadcast): wherever the change comes from — tray checkbox, settings window, or UI — the others update instantly. The UI language (中文 / English / 日本語 / Русский) applies everywhere: tray menus, window titles, the settings page, and top-bar hints.

## Other details

- **Frameless transparent window**, rounded body with a soft shadow; always on top by default, no taskbar entry
- Close/Esc hides to tray; **launch at login** writes to the current user's Run registry key (the checkbox state follows the system)
- **Position & preference memory**: window position (MyGo StateKey) and duration/sound/on-top/language/alarm duration (`userData/config.json`) are restored across launches
- **In-app updates**: one-click check against GitHub Releases from the settings window; newer versions are downloaded, swapped in and the app restarts itself; leftovers are cleaned up automatically
- Single instance: launching again brings the running timer to the front
- Timing is based on timestamp differences, so it stays accurate after system sleep or throttling; at zero the digits flash and the ascending chime loops — **click the timer (or Space/R) to stop it**; the default is "loop until stopped", changeable in Settings to play once / 10 s / 30 s; the last 10 seconds flash red
- **Animations**: a pendulum-like sway when the timer starts and a ring-style shake with each chime round at zero — toggle in Settings

## Usage

| Action | Effect |
| --- | --- |
| Drag the body | Move the window |
| Click the bar / LCD | Start / pause (cycle mode: confirm next phase / dismiss "day complete") |
| Double-click the LCD | Reset |
| Mouse wheel over the bar | ±1 minute (countdown mode) |
| Top-bar input | Custom duration (1–99 min), Enter to confirm (countdown mode) |
| Space / R | Start-pause / reset |
| S | Skip current phase (cycle mode) |
| ↑ / ↓ (Shift) | ±1 (±5) minute (countdown mode) |
| Esc | Hide to tray |

## Development

Requires Go 1.27+ and Windows 10/11 (ships with the WebView2 Runtime).

```bash
# Dev build: keeps the console window so you can see logs
go build -ldflags "-X github.com/egoist/mygo.production=1" -o timer.exe .
./timer.exe

# Release build: -H windowsgui removes the console window, -s -w strips debug info
go build -trimpath -ldflags "-s -w -H windowsgui -X github.com/egoist/mygo.production=1" -o timer.exe .
```

The version lives in `version.go`. Pushing a `v*` tag triggers GitHub Actions, which injects the tag as the version, builds, packages the zip and creates the Release automatically (`.github/workflows/release.yml`) — no manual web upload needed.

The frontend lives in `frontend/` (plain static files, no build step): `i18n.js` is the multilingual dictionary shared by the main and settings windows. To add a language, add it in both Go's `i18n()` (tray/titles) and `i18n.js` (page text). Opening `frontend/index.html` in a browser previews the styling (with a graceful fallback: localStorage instead of the Go bindings).

### Structure

```
main.go            MyGo windows (frameless/transparent/on-top), tray, settings window, state events, single instance
prefs.go           Preference persistence: config.json read/write, schema-version migration chain, validation
prefs_test.go      Tests for the persistence layer (legacy configs, migration, clamping)
version.go         App version (rewritten automatically by CI on tag push)
frontend/
  index.html       Main timer UI
  settings.html    Settings window (General / Timetable two-pane layout)
  i18n.js          Multilingual dictionary (Chinese/English/Japanese/Russian)
  style.css        Body / bar / LCD / controls styling
  settings.css     Settings window styling
  timer.js         Timer logic & interactions, schedule engine, state sync
  fonts/           DSEG7 Classic font (MIT)
assets/tray.png    Tray icon
```

### Debug flags (against the running instance)

```bash
./timer.exe --settings                     # Open the settings window
./timer.exe --update                       # Check and apply an update
./timer.exe --controls --shot out.png      # Keep the top bar visible and capture the main window page
./timer.exe --shot-settings out.png        # Capture the settings window page
./timer.exe --set sound=off                # Toggle switches externally: sound|pin|autostart=on|off
./timer.exe --set lang=en                  # Switch language: zh-CN|en|ja|ru
./timer.exe --set alarm=loop               # Alarm duration: once|10|30|loop
./timer.exe --set mode=cycle               # Timer mode: countdown|cycle
./timer.exe --set cyclework=1              # Cycle work length in minutes (cyclerest likewise)
./timer.exe --set schedule=09:00-12:00:cycle,12:00-13:30:break   # Inject a schedule for testing
```

Set the `TIMER_RELEASE_API` environment variable to override the update feed (defaults to `https://api.github.com/repos/ctzcs/Timer/releases/latest`; when the API is rate-limited or blocked it automatically falls back to resolving the `releases/latest` redirect).
