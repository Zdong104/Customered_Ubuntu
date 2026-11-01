# Customered_Ubuntu

一条命令，把一台 **Ubuntu 26.04 桌面版** 装成和我一样顺手的电脑：常用软件、开发工具、中文输入法、
一套 GNOME 桌面增强扩展和默认设置。之后我每次改进配置，你的电脑会在后台**自动更新**，完成后弹出通知。
不包含我的任何个人数据。

*English summary at the end.*

## 安装

1. 打开终端（按 `Ctrl+Alt+T`）。
2. 粘贴这条命令并回车，输入你的开机密码：`wget -qO- https://raw.githubusercontent.com/Zdong104/Customered_Ubuntu/main/bootstrap.sh | sudo bash`
3. 显示“安装完成”后，注销并重新登录一次（如果提示需要重启，就再重启一次）。

首次安装大约 30–60 分钟，需要联网，期间可以照常用电脑。中途断了也没关系：再运行一次同一条命令，会从中断处继续。
个别软件下载失败（比如某个厂商的下载地址临时不可用）不会中断安装，结束时会列出来，之后在后台自动重试。

可选：命令末尾换成 `| sudo bash -s -- --reset-desktop`，会把**你自己的**桌面外观立即改成和我一样
（只重置下面“桌面默认设置”里列出的选项）。不加这个参数时，你已经改过的设置一律保留。

安装前会先检查：Ubuntu 26.04、x86_64、GNOME 桌面、系统盘至少 25 GB 可用空间、能连上 GitHub；
任何一项不满足都会用中文说明原因，并且不改动电脑上的任何东西。电量低于 30% 时只会提醒接上电源。

## 你会得到什么

### 应用

| 类别 | 内容 |
|---|---|
| 浏览器 / AI | Google Chrome、Firefox（Mozilla 官方 .deb 版，不是 snap）、Claude 桌面版、ChatGPT 桌面版 |
| 沟通 | 微信、Zoom、Slack、Discord |
| 编辑 / 办公 | VS Code、Inkscape、PDF Arranger、img2pdf、Showtime 视频播放器、Remmina 远程桌面 |
| 3D / 设计 | Blender、FreeCAD（edge 版） |
| 其它 snap | Cheese 摄像头、iCloud for Linux、nvtop（GPU 监视）、astral-uv、View |
| 虚拟化 / 容器 | QEMU + libvirt + virt-manager（含 UEFI/OVMF、TPM 模拟 swtpm）、Docker |
| 媒体 / 驱动 | 常用解码器（ubuntu-restricted-addons）、Intel 硬件视频解码 |
| 工具 | cc-switch（Claude Code / Codex 配置切换）、tmux、7zip、zstd、剪贴板工具等 |

### 开发环境

- 编译工具链：build-essential、cmake、autotools、pkg-config、git、Node.js + npm、Python 3（pip/venv/dev）、Java（OpenJDK 25）、Vulkan 工具和一批常用开发头文件。
- 命令行 AI 工具：**Claude Code**、**Codex**（全局 npm，在 `/usr/local`）。
- **Miniconda**：装在 `/opt/miniconda3`，所有用户可用，默认不自动激活（需要时运行 `conda activate`）；你自己的环境放在 `~/.conda`。
- **TinyTeX**（含 XeLaTeX，可直接编译中文文档），命令在 `/usr/local/bin`。
- **uv** 工具 `harbor`。

### 中文输入

- **fcitx5 拼音**（含云拼音），中英文语言包、Noto CJK 和文鼎字体；新老用户登录后都默认使用 fcitx5（`Ctrl+Space` 切换）。
- 修复了 Wayland 下 Chrome / Claude 桌面版里**候选框位置错乱**的问题：它们改为在 XWayland 下启动（每次软件包升级后会自动重新应用）。

### 语音输入：Vocalinux

- 本地离线语音转文字（whisper.cpp，支持 Vulkan GPU 加速，没有 GPU 时自动用 CPU），登录后在后台启动；模型在第一次使用时下载。
- 附带触控板防误触修复：Vocalinux 会接管内置键盘，导致“打字时禁用触控板”失效，这里通过 libinput quirk 修好了。

### GNOME 扩展

| 扩展 | 作用 |
|---|---|
| Workspace Manage | 像 macOS 调度中心一样管理工作区：在概览里拖动缩略图排序，“+” 新建，悬停 “×” 删除（窗口移到相邻工作区）；主屏和副屏都支持。 |
| Maximize to Own Workspace | 最大化或全屏的窗口自动独占一个工作区，取消最大化后合并回去；副屏也支持。 |
| Workspace Islands | 副屏拥有自己独立的一组工作区（GNOME 自带只在主屏有工作区）。 |
| Hide Minimized | 最小化的窗口不再出现在概览和 Alt+Tab 里，从 Dock 或 Super+Tab 恢复。 |
| Raise Browser | 在微信等应用里点链接时，把 Chrome 带到最前面（Wayland 下默认不会）。 |
| Thumbnail Wallpaper | 概览顶部的工作区缩略图显示壁纸，而不是一片灰色。 |
| DND Hides Critical | 开启勿扰模式后，连“紧急”通知横幅也不弹（例如网页版 Teams 的消息），通知仍进入通知列表。 |
| Cursor Tracker | 通过 D-Bus 提供鼠标位置，供屏幕操作类工具使用。 |
| 桌面图标（DING）补丁 | 桌面上的文件按空格键可用 Sushi 快速预览；桌面图标只显示在主屏。系统升级后自动重新打补丁。 |
| Ubuntu 自带 | Dock、平铺助手（Tiling Assistant）、桌面图标等保持启用。 |

每个扩展只会为你自动启用一次：如果你在“扩展”应用里关掉了某一个，它会一直保持关闭。

### 文件管理器（Files）

- **最近使用的文件夹**会出现在“最近”里（GNOME 默认只显示文件），可直接打开或往里拖文件。
- “最近”里的文件会正确显示**缩略图**。
- 默认列表视图、压缩默认 zip、文件选择框显示路径栏、文件夹排在前面。

### 桌面默认设置

这些只是**默认值**：你自己改过的设置永远优先，自动更新也不会覆盖。

- 深色模式（Yaru-dark），显示电池百分比，热角开启，壁纸“Twin brothers”。
- 固定 1 个工作区（可用 Workspace Manage 增加），工作区只在主屏切换；Alt+Tab 显示所有工作区的窗口。
- Dock 图标大小 42，收藏：文件、Chrome、VS Code、Claude、设置、微信、应用中心、终端、文本编辑器、View。
- 平铺助手：橙色焦点提示，平铺弹窗显示所有工作区窗口。
- 触控板轻点即点击、双指滚动、打字时禁用 1.5 秒；鼠标/触控板速度略快。
- 电源：不自动熄屏、不变暗、插电和用电池时都不自动休眠；低电量时不强制省电模式。
- 护眼提醒：每 30 分钟提醒活动 5 分钟。夜灯色温 3330K（是否开启由你决定）。
- 不自动发送错误报告。

### 硬件

- **NVIDIA 显卡**：如果还没有装驱动，自动安装 Ubuntu 推荐的驱动（已有驱动则不碰）。
- **ThinkPad P1 Gen 8**（按机型识别，其他电脑不受影响）：修复内屏黑屏/闪烁（关闭 PSR、自动重新点亮面板，`Super+Shift+D` 手动修复）、雷电 5 外接显示器、NVIDIA PRIME 按需模式、PipeWire 音频崩溃后自动重启。

### 用户组

为了让语音输入和虚拟化开箱即用，所有用户加入 `input` 组；管理员（sudo 组）另外加入 `adm kvm libvirt docker`。
注意：`docker` 组等同于 root 权限，`input` 组可以读取键盘输入。

## 自动更新

- 每次开机 15 分钟后和每天一次（随机延后最多 2 小时）在后台检查；用电池且电量低于 30%，或连接的是计费网络（手机热点）时跳过。
- 以低优先级运行（内存上限 4 GB），不影响正常使用；只重新执行改动过的部分，一般几秒到几分钟。
- 完成后弹出通知“桌面配置已更新到 vX”；失败的项目会在之后自动重试。
- 只会**新增或更新**东西：软件包不会被自动卸载（除非明确列在 `payload/remove.txt`），
  我不再提供的配置文件会被删除，如果原来你电脑上就有同名文件，会恢复成你原来的版本。
- 系统本身的升级（内核、软件包）仍然由 Ubuntu 自己的“软件更新器”负责。

常用命令：

```
preload-update --status          # 当前版本、上次更新结果、下次检查时间
sudo preload-update --now        # 立即检查并更新
sudo preload-update --check      # 只检查有没有新版本
preload-update --rollback-info   # 更新历史，以及如何撤销
```

### 安全性

自动更新以 root 身份执行仓库里的代码，所以只接受经过我的**签名密钥**签名的发布：

- 只接受名为 `vYYYY.MM.DD[.N]` 的带注释标签，用 `git verify-tag` 按 SSH 签名验证，公钥在安装时固定在
  `/etc/preload/allowed_signers`（也写在 `bootstrap.sh` 里）。分支、未签名或别人签名的提交一律不执行。
- 标签对象里签名过的名字必须和标签名一致，旧的签名标签无法换个新名字重放；版本号只升不降。
- 每次都从标签对应提交的干净副本（`git archive`）执行，只通过 HTTPS 下载。
- 换密钥的方式：用旧密钥签名一个包含新公钥的发布。

也就是说，即使 GitHub 仓库被别人改动，只要签名私钥没有泄露，你的电脑就不会执行它。

## 不包含什么

不含我的任何个人数据：没有文档、浏览器资料、聊天记录、密钥/SSH/GPG、Wi-Fi 密码、打印机、虚拟机或容器镜像、
conda 环境、各种 token 和 AI 工具的登录状态，也不会创建任何账户或改你的主机名。发布前会自动做一次泄露扫描。

## 停止更新 / 卸载

```
sudo preload-update --disable      # 停止自动更新（已安装的内容都保留）
sudo systemctl enable --now preload-update.timer   # 重新开启
sudo preload-update --uninstall    # 移除更新程序本身（已安装的软件和设置保留）
```

已安装的软件可以像平常一样用“应用中心”、`sudo apt remove` 或 `sudo snap remove` 卸载；扩展可在“扩展”应用里关闭；
桌面默认值可以删掉 `/usr/share/glib-2.0/schemas/90_preload.gschema.override` 后运行
`sudo glib-compile-schemas /usr/share/glib-2.0/schemas` 恢复 Ubuntu 原样。

## English summary

One command turns an Ubuntu 26.04 Desktop (x86_64, GNOME) into the owner's setup, then keeps it updated
silently in the background:

```
wget -qO- https://raw.githubusercontent.com/Zdong104/Customered_Ubuntu/main/bootstrap.sh | sudo bash
```

It checks the machine first (and changes nothing if a check fails), takes about 30-60 minutes, can be
re-run to resume, and keeps going if a single optional download fails. Log out and back in once when it
finishes. It installs the apps, developer toolchains, Chinese input, Vocalinux voice typing, the GNOME
extensions and desktop defaults listed above. Updates come only from SSH-signed release tags verified against
a pinned key (no branches, no downgrades, no replayed tags, https only); see `preload-update --status`.
Your own settings always win over the defaults. No personal data of the owner is included.

## For the owner: releasing

```
# edit payload/ (or updater/), commit, then:
./release.sh -m "what changed"       # clean tree, leak scan, next vYYYY.MM.DD[.N], SSH-signed tag, verified
git push origin HEAD:main && git push origin vYYYY.MM.DD     # printed by release.sh; nothing ships before this
```

- The signing key is `~/.ssh/preload-release` (ed25519, created without a passphrase). Add one with
  `ssh-keygen -p -f ~/.ssh/preload-release`; release.sh then asks for it. Keep an offline backup: without it,
  installed machines cannot be updated (each would need `sudo rm /etc/preload/allowed_signers` and a re-run
  of the install command with a new key).
- Key rotation: add the new public key to `updater/allowed_signers` and `bootstrap.sh`, release signed with the
  old key, then sign with the new key and drop the old line in a later release.
- The leak scan needs the private patterns file `~/.config/preload/leak-patterns.sh`
  (template: `test/leak-patterns.example.sh`). `test/leakscan.sh --history` scans every commit.
- Each step of `payload/provision.sh` re-runs on a machine only when its inputs change (its own code, its
  payload files, or its `sources.conf` line); "latest" download URLs are refetched only when their line changes.
- Tests: `test/update-e2e.sh` (bootstrap, refused tags, downgrade, incremental update, ISO-style install, in a
  disposable systemd container; needs docker).
- The bootable ISO for new machines is built from the same payload: see [docs/ISO.md](docs/ISO.md).
