# 桌面置顶计时器

[English](README.md)

仿实体视觉计时器的 Windows 桌面小部件：白色圆角机身浮在桌面上，左侧 30 段刻度条随时间熄灭，右侧液晶七段码屏显示 `分.秒`。支持中文 / English / 日本語 / Русский。

基于 [MyGo](https://github.com/egoist/mygo)（Go + 系统 WebView2），纯 Go 无 cgo，release 构建产物为单个 ~9MB 的 `timer.exe`，前端为内嵌的纯静态 HTML/CSS/JS。

![预览](assets/tray.png)

## 功能分层

- **顶栏（悬停浮现，高频操作）**：自定义时长输入、±1/±5 分钟、开始/暂停、归零、隐藏到托盘
- **托盘（低频开关 + 入口）**：显示/隐藏、窗口置顶、提示音、开机自启、设置…、退出
- **设置窗口**（托盘「设置…」打开）：语言切换、到点铃声时长、提示音、窗口置顶、开机自启

三处共享同一份状态（Go 为唯一事实源 + `state` 事件广播）：托盘勾选、设置窗口、界面文案任一处变化，其余即时同步。界面语言支持中文 / English / 日本語 / Русский，托盘菜单、窗口标题、设置页、顶栏提示文案全部跟随。

## 其他

- **无边框透明窗口**，圆角机身 + 柔和投影，默认置顶，不占任务栏
- 关闭/Esc 隐藏到托盘；**开机自启**写当前用户 Run 注册表项（勾选状态以系统为准）
- **位置与偏好记忆**：窗口位置（MyGo StateKey）和时长/声音/置顶/语言（`userData/config.json`）跨启动恢复
- 单实例：重复启动把计时器叫到前台
- 计时基于时间戳差值，系统休眠或节流后仍准确；归零时数字快闪 + 上行铃音循环响，**点击计时器（或空格/R）即停**；时长默认「持续响」，可在设置里改为响一遍 / 10 秒 / 30 秒；最后 10 秒末段闪红

## 操作

| 操作 | 效果 |
| --- | --- |
| 拖动机身 | 移动窗口 |
| 单击刻度条 / 液晶屏 | 开始 / 暂停 |
| 双击液晶屏 | 归零 |
| 滚轮（刻度条上） | ±1 分钟 |
| 顶栏输入框 | 自定义时长（1–99 分钟），回车确认 |
| 空格 / R | 开始暂停 / 归零 |
| ↑ / ↓（Shift） | ±1 分钟（±5） |
| Esc | 隐藏到托盘 |

## 开发

需要 Go 1.27+ 和 Windows 10/11（自带 WebView2 Runtime）。

```bash
# 开发：保留控制台窗口方便看日志
go build -ldflags "-X github.com/egoist/mygo.production=1" -o timer.exe .
./timer.exe

# 发布：-H windowsgui 不弹控制台窗口，-s -w 去调试信息减小体积
go build -trimpath -ldflags "-s -w -H windowsgui -X github.com/egoist/mygo.production=1" -o timer.exe .
```

前端在 `frontend/`（纯静态，无构建步骤）：`i18n.js` 是主窗口与设置页共用的多语言字典，加语言时在 Go 的 `i18n()`（托盘/标题）和 `i18n.js`（页面文案）各加一份即可。直接用浏览器打开 `frontend/index.html` 可预览样式（自动降级：localStorage 代替 Go 绑定）。

### 结构

```
main.go            MyGo 窗口（无边框/透明/置顶）、托盘、设置窗口、偏好持久化、state 事件、单实例
frontend/
  index.html       计时器主界面
  settings.html    设置窗口（语言 + 开关）
  i18n.js          多语言字典（中文/英/日/俄）
  style.css        机身/刻度条/液晶屏/控制条样式
  settings.css     设置窗口样式
  timer.js         计时逻辑与交互、状态同步
  fonts/           DSEG7 Classic 字体（MIT）
assets/tray.png    托盘图标
```

### 调试参数（对运行中的实例）

```bash
./timer.exe --settings                     # 打开设置窗口
./timer.exe --controls --shot out.png      # 顶栏常显并截取主窗口页面
./timer.exe --shot-settings out.png        # 截取设置窗口页面
./timer.exe --set sound=off                # 外部驱动开关：sound|pin|autostart=on|off
./timer.exe --set lang=en                  # 切换语言：zh-CN|en|ja|ru
./timer.exe --set alarm=loop               # 到点铃声：once|10|30|loop
```
