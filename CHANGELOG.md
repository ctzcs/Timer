# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-10-20

### Added

- **Daily cycle mode** (∞ button in the top bar, or "Timer Mode" in Settings): like a school timetable, you lay out your day in Settings as time slots — **cycle** slots alternate work/break (default 45 + 10 min, configurable) and **break** slots are plain rest (lunch, a nap). Everything is anchored to clock times: click start at any moment and the timer joins the slot in progress; gaps count down as break; starting after the last slot ends the day with a "day complete" chime. Rest phases light the segment bar green, an LCD badge shows work / break / day complete, and `»` / `S` skips to the next phase while keeping its scheduled end time. With no slots configured the mode is an endless work/break loop. Auto-advance (on by default) rings once and moves on; turn it off to confirm each phase with a click.
- **Schedule persistence with schema versioning**: `config.json` now carries a `version` field with a migration chain, so upgrades never destroy user data (0.1.x configs migrate transparently); corrupt config files are backed up as `config.json.bak` instead of being overwritten.
- New debug flags: `--set mode=countdown|cycle`, `--set cyclework=1`, `--set cyclerest=1`, `--set schedule=09:00-12:00:cycle,12:00-13:30:break`.
- The settings window now uses a two-pane layout — a sidebar with "General" and "Timetable" sections instead of one long form — and is resizable with scrollable content. The daily schedule UI is called "Timetable" throughout.
- The release CI runs `go vet` + `go test` before building.

## [0.1.5] - 2026-10-14

### Fixed

- **In-app update restart silently failed**: the new version was downloaded and swapped in, but the app never relaunched itself (`os.StartProcess` without std handles fails on Windows). After updating, users had to reopen the app manually. From this version on, the app restarts itself automatically.
- The leftover `timer.exe.old` from an update is now removed by a background retry instead of a single attempt that could race the old process shutting down (or a transient antivirus scan).

## [0.1.4] - 2026-10-14

### Changed

- Device animations no longer follow the system "reduced motion" preference — they always play unless disabled in Settings (the sway is subtle by design).

## [0.1.3] - 2026-10-13

### Added

- **Device animations** (toggle in Settings, on by default): a pendulum-like sway when the timer starts, and a ring-style shake with each chime round when the countdown finishes.
- **CI release automation**: pushing a `v*` tag builds the Windows exe on GitHub Actions, injects the tag as the app version, packages the zip and publishes the GitHub Release with notes from this changelog.

## [0.1.2] - 2026-10-13

### Added

- **In-app updates**: a "Check for updates" button in the settings window queries GitHub Releases; when a newer version is found it offers "Download & update", which downloads the release zip, swaps in the new exe after quit and restarts the app automatically. Old files are cleaned up on the next launch, and the single-instance lock is retried briefly so the restarted instance takes over cleanly.
- The settings window footer shows the running version (served by the app, not hardcoded in the page).
- `--update` debug flag and the `TIMER_RELEASE_API` environment variable to override the update feed.
- Fallback update check: when `api.github.com` is rate-limited or blocked (HTTP 403), the latest tag is resolved from the `releases/latest` page redirect and the asset URL is constructed from the release naming convention.

## [0.1.1] - 2026-10-13

### Added

- **Settings window** (tray → "Settings…"): UI language, alarm duration, sound, always-on-top and launch-at-login in one place, with the app version shown at the bottom.
- **UI localization**: Chinese, English, Japanese and Russian across the tray menu, window titles, the settings window and top-bar hints. Adding a language only requires one entry in Go's `i18n()` and one in `frontend/i18n.js`.
- **Looping completion alarm**: when the countdown reaches zero, the chime keeps playing until you click the timer (or press Space/R, hide to tray, or mute). The default is "loop until clicked"; "play once / 10 s / 30 s" are available in Settings, and the choice persists across launches.
- **Custom duration input** in the hover bar: type 1–99 and press Enter; the wheel and ±1/±5 buttons still work, and the input locks while running.
- `--settings` / `--shot-settings` / `--set sound|pin|autostart|lang|alarm=…` debug flags for driving a running instance externally.

### Changed

- **Clearer layering between the hover bar and the tray**: the hover bar now only holds high-frequency actions (duration, ±, start/pause, reset, hide); infrequent toggles (sound, always-on-top, launch at login) moved to the tray menu and the settings window. All entry points share one state and stay in sync instantly (Go is the single source of truth, changes broadcast as `state` events).
- More formal wording for the alarm-duration options in all four languages.

### Fixed

- Tray menu checkboxes and labels did not refresh after state changes: MyGo installs a tray-menu snapshot, and `SetChecked`/`SetLabel` only update application/window menus. The menu is now re-installed after every change.
- The bound service used a separate struct instance, so preferences loaded at startup never reached the frontend (the UI fell back to defaults). The global app instance is now bound directly.
- The settings window (and some WebView2 states of the main window) could still show a taskbar/Alt+Tab entry despite `SkipTaskbar`: both windows now set `WS_EX_TOOLWINDOW`, so the app lives only in the tray. The settings window also disables minimize (nothing to restore it from) and shows the app icon in Alt+Tab.

## [0.1.0] - 2026-10-12

### Added

- Initial release: frameless, transparent, always-on-top desktop timer styled after a physical visual timer — a 30-segment depleting bar and a seven-segment `min.sec` LCD on a white rounded body.
- Tray with show/hide, always-on-top, quit; close/Esc hides to tray; single instance; window position and duration remembered across launches.
- Hover controls (duration ±, start/pause, reset, hide), wheel adjustment, keyboard shortcuts, last-10-seconds red flash and a completion chime.
