# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

## [0.1.0] - 2026-10-12

### Added

- Initial release: frameless, transparent, always-on-top desktop timer styled after a physical visual timer — a 30-segment depleting bar and a seven-segment `min.sec` LCD on a white rounded body.
- Tray with show/hide, always-on-top, quit; close/Esc hides to tray; single instance; window position and duration remembered across launches.
- Hover controls (duration ±, start/pause, reset, hide), wheel adjustment, keyboard shortcuts, last-10-seconds red flash and a completion chime.
