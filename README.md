# 拾光 · 本地素材工作台

把 Excel 选题表变成可人工审核的图片与文案，再保存、挑选和管理待发布素材。图片与文案通过 **Codex CLI + 自己的 ChatGPT 订阅账号**生成；导入、排队、审核、存储与发布标记由本地程序完成，不需要 OpenAI API Key。

当前版本面向 **macOS / Windows、单人、本机使用**，使用 React + TypeScript、Node.js 和 SQLite。图片原文件保存在本地，不会随 Git 推送。发布按钮只记录“已发布”，不会登录或操作小红书。

## 目录

- [从零安装](#从零安装)
- [第一次生成素材](#第一次生成素材)
- [日常使用与启停](#日常使用与启停)
- [修改配置与提示词](#修改配置与提示词)
- [中断恢复与异常处理](#中断恢复与异常处理)
- [备份迁移与升级](#备份迁移与升级)
- [常见问题](#常见问题)
- [开发与验证](#开发与验证)

## 从零安装

### 1. 准备环境

| 条件 | 要求与检查方法 |
| --- | --- |
| 操作系统 | macOS，或 Windows 10/11；Windows 使用原生 Node.js、Codex CLI、PowerShell 和资源管理器，本文不混用 WSL 环境 |
| Git | 执行 `git --version`；Mac 按系统提示安装命令行开发工具，Windows 安装 [Git for Windows](https://git-scm.com/downloads/win) 后重新打开终端 |
| Node.js 与 npm | 安装 [Node.js 24](https://nodejs.org/en/download)，然后执行 `node --version` 和 `npm --version`；本项目要求 Node.js **24 或更新版本** |
| ChatGPT 账号 | 使用自己的、具备 Codex 使用权限的订阅账号，并确认有目标模型和内置生图工具的权限 |
| 网络代理 | 准备能够访问 ChatGPT 的 HTTP / HTTPS 代理；本项目必须配置代理，不支持将代理留空 |
| 本地空间 | 项目及数据目录可写，并为原图保留足够磁盘空间 |

Mac 已完成真实生成验证；Windows 已添加原生启停与 CLI 适配，并覆盖相关逻辑测试，**尚未完成 Windows 真机端到端验收**。Windows 用户应先用一个选题验证工具和账号环境。

作者验证环境为 Node.js 24.18.0、Codex CLI 0.145.0 和 Pro 账号。默认主模型是 `gpt-5.6-sol`，思考程度为 `high`。这些是已测环境，**不代表所有账号、CLI 版本或 Plus 并发额度均已验证**。安装和登录后，请先按下文跑通一个选题，再增加并发。

生成图片依赖 Codex 运行环境提供的 **内置 `image_gen` 工具及 `imagegen` 技能**。本仓库没有打包这些能力；单独安装 CLI 或复制一个技能文件并不能保证账号获得生图权限。主模型名称也不等同于图像引擎型号。若当前 CLI 会话没有该工具，图片阶段会报错，不会自动转用 API 付费接口。

### 2. 配置终端网络并克隆仓库

Mac 打开“终端”，Windows 打开 PowerShell。如果网络访问 GitHub、npm 或 ChatGPT 需要代理，先执行下列命令，**把 `7897` 换成自己的代理 HTTP 或混合端口**，并确保代理软件已启动：

**macOS：**

```sh
export HTTPS_PROXY="http://127.0.0.1:7897"
export HTTP_PROXY="$HTTPS_PROXY"
export ALL_PROXY="$HTTPS_PROXY"
export NO_PROXY="localhost,127.0.0.1,::1"
```

**Windows PowerShell：**

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = $env:HTTPS_PROXY
$env:ALL_PROXY = $env:HTTPS_PROXY
$env:NO_PROXY = "localhost,127.0.0.1,::1"
```

这些变量只影响当前终端，后面还需要修改项目的 `config.toml`。本地网页应直接访问，不经代理。不要将 SOCKS 专用端口填成 HTTP 代理。

macOS 克隆并进入项目目录：

```sh
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/three-watersss/design.git
cd design
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$HOME/Projects" | Out-Null
Set-Location "$HOME/Projects"
git clone https://github.com/three-watersss/design.git
Set-Location design
```

仓库为 public，使用上述 HTTPS 地址克隆或 `git pull` **不需要 GitHub Key / Token**。推送修改仍需要写入权限及认证。若已有副本使用 SSH 地址，可执行 `git remote set-url origin https://github.com/three-watersss/design.git` 改为 HTTPS。

后面的项目命令均在这个 `design` 目录中执行。仓库包含提示词 Markdown 模板，无需另找原始 DOCX 模板；新克隆的仓库不包含作者的素材、数据库或登录凭据。

### 3. 安装 Codex CLI，并用自己的 ChatGPT 账号登录

```sh
npm install -g @openai/codex
codex --version
codex login
codex login status
```

根据提示在浏览器完成 **ChatGPT 登录**。最后一条命令应显示当前通过 ChatGPT 登录；仅在浏览器登录 ChatGPT 并不等于 CLI 已登录。不要选择 API Key 登录，也无需创建 `.env` 或填写 API Key。

官方说明：[Codex CLI](https://developers.openai.com/codex/cli/) · [登录与认证](https://developers.openai.com/codex/auth/) · [Windows 环境](https://developers.openai.com/codex/windows)。ChatGPT 订阅登录与 API Key 计费是两种不同接入方式；本工具固定使用前者。CLI 凭据保存在你的本机 Codex 环境中，不要将凭据文件复制给其他使用者或提交到仓库。

Windows 下若 PowerShell 提示禁止执行 `npm.ps1` 或 `codex.ps1`，使用 `npm.cmd`、`codex.cmd` 替代下面或上面的同名命令，例如 `npm.cmd install -g @openai/codex`、`codex.cmd login`，无需修改全局执行策略。

Mac 若安装提示 `EACCES` 权限错误，可以改用个人目录安装，然后重新执行上面的登录命令：

```sh
npm install -g --prefix "$HOME/.npm-global" @openai/codex
export PATH="$HOME/.npm-global/bin:$PATH"
```

项目的双击启动脚本已经包含该目录。若希望以后新开的终端也能直接运行 `codex`，将这条 `export PATH=...` 加入自己的 shell 配置，例如 macOS 默认 zsh 的 `~/.zshrc`。

### 4. 从模板创建本地配置

仓库只保存 [config.toml.eaxmple](config.toml.eaxmple)，不再跟踪实际的 `config.toml`。首次使用先复制一份（模板文件名按仓库实际拼写为 `.eaxmple`）：

macOS：

```sh
cp config.toml.eaxmple config.toml
```

Windows PowerShell：

```powershell
Copy-Item config.toml.eaxmple config.toml
```

也可在文件管理器中复制模板并改名为 `config.toml`，注意不要变成 `config.toml.txt`。**已有配置时不要重复复制覆盖。** 用文本编辑器打开新建的 `config.toml`，模板默认内容为：

```toml
[server]
port = 4317
data_dir = "./data"

[generation]
model = "gpt-5.6-sol"
reasoning_effort = "high"
max_concurrency = 3
timeout_minutes = 30
codex_bin = "codex"

[network]
proxy = "http://127.0.0.1:7897"
```

首次使用请至少确认：

1. `proxy` 已换成自己实际可用的 HTTP / HTTPS 代理地址。终端代理变量不会替代这里的配置。
2. 建议先将 `max_concurrency` 改成 **1**，单选题验证成功后再逐步增加。仓库默认 3 是本工具的并发上限设置，不是 Plus 或 Pro 的安全容量承诺。
3. `model` 是自己的 Codex 账号可以调用的模型；保留默认值时也需要实际验证。如果模型不可用，应填写自己账号实际支持的模型名，而不是不断重试。
4. `codex_bin` 能找到已安装的 CLI。Mac 终端执行 `command -v codex`、Windows 执行 `where.exe codex` 可查询路径；双击启动找不到 CLI 时，将其输出的绝对路径填入此项。

Windows 的绝对路径建议使用正斜杠，例如 `codex_bin = "C:/Users/你的用户名/AppData/Roaming/npm/codex.cmd"`；不要在 TOML 双引号中直接写未转义的反斜杠。原生安装也可指定 `codex.exe`，非标准 npm 包装脚本可改为 `codex.js` 的绝对路径。

保留 TOML 格式和引号。首次启动会自动创建 `data` 目录，无需手工创建数据库。

### 5. 从模板创建本地提示词

仓库只保存 [图片提示词模板](prompts/images.example.md) 和 [文案提示词模板](prompts/copy.example.md)。首次使用时复制为程序实际读取的文件：

macOS：

```sh
cp prompts/images.example.md prompts/images.md
cp prompts/copy.example.md prompts/copy.md
```

Windows PowerShell：

```powershell
Copy-Item prompts/images.example.md prompts/images.md
Copy-Item prompts/copy.example.md prompts/copy.md
```

也可以在文件管理器中复制模板并去掉文件名中的 `.example`。**已有实际提示词时不要覆盖。** 后续只编辑 `prompts/images.md`、`prompts/copy.md`；这两份文件已被 Git 忽略，不影响拉取更新。修改模板文件不会改变程序使用的提示词，程序也不会在更新时自动覆盖实际提示词。

### 6. 启动工作台

Mac 双击 **启动素材工作台.command**；Windows 双击 **启动素材工作台.bat**。也可以在项目终端执行：

```sh
npm run launch
```

首次启动或依赖文件变化时，会自动运行 `npm ci` 安装项目依赖；随后构建界面、启动后台服务并打开浏览器。请等待终端显示打开地址；首次下载可能需要几分钟。启动脚本不会自动安装 Node.js、Codex CLI、代理软件或替你完成账号登录。

默认地址为 <http://127.0.0.1:4317>。修改端口后以启动器输出的地址为准。服务只绑定本机地址，不能作为局域网多人服务使用。

进入界面后查看右上角的环境检查，确认 CLI 登录、代理、提示词和目录权限检查通过。检查失败会暂停派发，按提示处理后点击“恢复队列”。**环境检查不验证账号的模型及生图权限；首次实际生成才是完整链路验证。**

## 第一次生成素材

### 准备 Excel 选题表

在 Excel、WPS 或 Numbers 中建立表格，并保存或导出为 **`.xlsx`**。第一张工作表的第一行必须包含以下两个表头；第二行开始填写选题：

| 账号名 | 主题 |
| --- | --- |
| momo | 工业机器人系统集成产品选型方案PPT |

可以直接把上表内容复制到表格软件中。仓库无需额外的示例 XLSX 文件即可使用。首次建议只填一条选题。

导入规则：

- 只读取第一张工作表，表头须为“账号名”“主题”；列顺序不限，其他列忽略。
- 两列都空的行忽略；只空一列的行标记错误，不入队。
- 账号名最长 100 字符、主题最长 1000 字符。单次最多 5000 行数据，文件最大 20 MB。
- “账号名 + 主题”相同视为重复，包括本次表格内和已有任务中的重复；默认跳过，可在预览中明确选择保留。
- 不支持直接导入 CSV、旧版 `.xls` 或 `.numbers` 文件，请先导出为 `.xlsx`。

### 跑通一条任务

1. 在“生成工作台”点击“导入选题”，上传表格，查看有效、错误和重复条目，确认入队。
2. 等待图片生成，打开任务检查整组原图。满意则点击“通过，生成文案”；不满意则“重新生成”。
3. 文案自动排队生成，模型会收到实际图片。检查标题、正文与图片，满意则“通过，保存素材”；否则重新生成文案。
4. 在素材库的“未发布”页找到这组完整素材，确认图片和文案可以正常查看。
5. 到发布台挑选该素材，尝试复制文案、下载图片或完整素材包。测试素材无需标记发布，可以回素材库删除。

图片生成可能耗时较长，默认单阶段超时 30 分钟。等待人工审核的任务不占生成并发名额。程序校验不代替人工审核，请自行检查图片文字、事实、排版和文案是否适用。

## 日常使用与启停

### 生成、素材库与发布台

- **生成工作台**：查看任务、按账号与阶段筛选，审核图片和文案；“暂停派发”只停止安排新任务，已经运行的阶段继续完成。
- **重新生成**：直接删除被放弃的当前结果，不保留历史版本。重新生成图片会清除该组图片及派生结果；重新生成文案保留已通过的图片。按钮不再追加确认弹窗。
- **素材库**：只展示图片和文案均已人工通过的完整素材，可筛选账号、主题和发布状态。未完成或待审核的任务请到生成工作台查看。
- **删除素材**：进入素材库“未发布”页，点击卡片左下角的垃圾桶图标并确认，永久删除整组本地素材及 SQLite 中的关联记录。已发布页没有删除入口。无需手工去数据文件夹删除。
- **发布台**：从未发布素材中随机挑选，也可按账号筛选。“换一组”不改状态，本轮排除已展示素材，候选耗尽后重新开始挑选。
- **组织发布内容**：挑选素材后，点击“图片组”旁的文件夹图标，在 Finder（Mac）或资源管理器（Windows）打开这组原图所在目录；也可以下载图片 ZIP、完整素材包和复制文案。需要整理时请复制到自己的发布目录，避免移动或删除应用保存的原文件。
- **发布标记**：自行在小红书完成发布后，点击本工具的“发布”记录状态和时间。工具不会代发笔记。

### 怎样关闭工具

| 操作 | 后台服务和正在生成的 CLI |
| --- | --- |
| 关闭或刷新网页 | 继续运行，重新打开网页即可查看 |
| 启动成功后关闭启动器终端窗口 | 继续运行，服务已在后台启动 |
| 点击“暂停派发” | 当前阶段继续完成，暂停启动新的阶段 |
| 双击 Mac 的停止 `.command` / Windows 的停止 `.bat` | 停止后台服务，并终止其正在运行的 CLI 子进程 |
| 再次双击对应系统的启动脚本 | 服务已运行时只打开现有页面；已停止时启动并恢复任务 |

终端停止方式：在项目目录执行 `node scripts/stop.mjs`。等待显示“素材工作台已停止”后再重启。前台调试使用 `npm start` 时，可用 `Ctrl+C` 停止。

## 修改配置与提示词

### 配置文件

修改本地 `config.toml` 后需要停止再启动。此文件已加入 `.gitignore`，后续 `git pull` 不会覆盖个人配置；模板新增配置项时可按更新说明手动补入。**修改端口或数据目录之前先停止现有服务**，否则启动器或停止脚本可能无法定位原来的实例。

| 配置项 | 用途 |
| --- | --- |
| `server.port` | 本机网页端口，默认 4317，有效整数范围 1–65535，须未被其他服务占用 |
| `server.data_dir` | SQLite 和素材目录，默认 `./data`；相对路径以项目根目录为基准，也支持绝对路径 |
| `generation.model` | Codex 主模型，默认 `gpt-5.6-sol`，须由当前账号支持 |
| `generation.reasoning_effort` | 思考程度，默认 `high`；程序接受 `none`、`low`、`medium`、`high`、`xhigh`、`max`，实际还受模型支持范围限制 |
| `generation.max_concurrency` | 图片与文案共用执行名额，默认 3，有效整数范围 1–16 |
| `generation.timeout_minutes` | 单阶段超时，默认 30 分钟，有效整数范围 1–240 |
| `generation.codex_bin` | CLI 命令或绝对路径，默认 `codex` |
| `network.proxy` | 必填 HTTP / HTTPS 代理地址；CLI 子进程显式使用此代理 |

数据目录不能是项目根目录或其上级。改变路径不会自动迁移数据，应按下文先备份再迁移；新空目录会显示为空工作台。若在仓库内另设数据目录，请同步加入 `.gitignore`，避免误提交素材。

### 提示词文件

- `prompts/images.md`：本地实际图片提示词，可自行编辑；首次从 [images.example.md](prompts/images.example.md) 复制。
- `prompts/copy.md`：本地实际文案提示词，生成时同时附带实际图片；首次从 [copy.example.md](prompts/copy.example.md) 复制。

程序只读取以上两份实际文件，不直接读取模板，也不会自动用模板补齐或覆盖个人文件。仓库跟踪 `*.example.md` 模板，两份实际提示词不纳入 Git；若需要采用新版模板，请自行比较并修改实际文件。

两份文件均须保留 `{{topic}}` 占位符，用来注入主题；可选 `{{account}}` 注入账号名。使用 UTF-8 纯文本保存，不要把 DOCX 文件直接改名为 Markdown。程序只替换上述占位符，其余文字（包括自己写入的“（可变参数）”“（可替换参数）”）都会原样发送，不会自动删除。

每次新生成及人工重新生成都会读取最新提示词，**修改提示词无需重启**。已开始的执行固定使用开始时保存的快照；中断后的自动恢复、退避重试继续使用该快照。

图片张数由提示词决定，程序不要求固定六张，只拒绝空图片结果。文案保留 `title`、`body` 的结构、字符串类型和非空校验，不检查标题或正文的字符数量；界面的字符统计仅供参考。图片尺寸偏差只提示，不自动缩放。全部程序化校验见 [生成结果检查](docs/生成结果检查.md)。

## 中断恢复与异常处理

SQLite 持久化每个阶段和执行记录，启动时自动恢复：

- 等待审核的任务继续等待，不重新生成；完整素材与发布状态保持不变。
- 图片阶段未完成时，删除整组半成品后重新生成；文案阶段中断只恢复文案，保留已通过的图片。
- 结果已完整落盘、执行成功且通过校验，但尚未提交阶段状态时，恢复为待审核。
- 删除中断时继续清理；通过单实例锁与执行编号防止重复派发及旧结果覆盖新结果。

停止服务时会终止本工具所属的 CLI 进程，恢复前确认旧执行已结束。不要同时用多个项目副本指向同一个数据目录。

明确限流或并发错误会暂停新任务派发：前两次失败分别退避 60、120 秒；同一阶段连续第三次失败后停止自动重试，并冷却队列 240 秒。额度耗尽、登录失效或代理异常会阻塞队列，解决原因后点击“恢复队列”。其他异常显示在任务详情，不无限重试。

并发限制只约束本工具，其他 Codex 会话也会使用同一账号容量。不要用反复点击重生成来解决额度或权限问题。

## 备份迁移与升级

### 文件保存在哪里

| 位置 | 内容 | Git 是否保存 |
| --- | --- | --- |
| `data/materials.sqlite` | 任务、阶段、文案关联及发布状态 | 否 |
| `data/attempts/` | 当前图片、文案结果及执行所需文件 | 否 |
| `prompts/images.md`、`prompts/copy.md` | 本地实际提示词，可自行编辑 | 否 |
| `prompts/*.example.md` | 首次使用的提示词模板 | 是 |
| `config.toml` | 本机运行配置 | 否，个人配置不随拉取更新改变 |
| `config.toml.eaxmple` | 首次使用的配置模板 | 是 |
| `startup.log` | 后台启动诊断 | 否 |
| `node_modules/`、`dist/` | 依赖与构建产物，可重新生成 | 否 |

上表数据路径以默认配置为例。GitHub 仓库不是素材备份；克隆代码不会还原你的图片、任务或发布记录。前期验证记录如存在于本机 `validation/`，不会进入正式素材库，也不会包含在克隆结果中。

### 备份与换电脑

1. 停止服务，等待 CLI 子进程退出。
2. 将**整个数据目录**复制到项目以外的备份位置，同时备份 `config.toml` 和 `prompts/`。不要只复制 SQLite 而漏掉原图。
3. 在另一台同系统电脑按“从零安装”准备环境、克隆仓库并使用自己的账号登录。
4. 在目标服务停止时恢复整个数据目录和需要的提示词；调整配置中的代理、CLI 路径及数据路径，再启动。

Windows 与 Mac 之间的数据路径可能不同，当前未验证跨系统的数据迁移；请保留原备份。

放弃的生成结果会被清理，备份只包含备份时实际存在的文件。应用还会清理能明确归属本次执行的 Codex 生图缓存，不会清理其他 Codex 任务。

### 获取远端更新

日常更新只需**先停止工具**，在项目目录执行：

```sh
git pull --ff-only
```

然后双击对应系统的启动脚本。启动器会检测依赖文件变化、自动安装依赖并重新构建，不需要手工保存或恢复 `config.toml`、`prompts/images.md`、`prompts/copy.md`。网络受限时先设置本文的终端代理再拉取，并保持配置中的代理可用。

个人配置和两份实际提示词都已忽略，日常修改它们不会影响拉取。若修改了仓库模板或代码，仍可能需要提交、临时保存或合并这些修改；可用 `git status --short` 检查。

**旧版首次升级到“本地配置”版本：** 旧版曾将 `config.toml` 纳入 Git，拉取这次删除跟踪的更新时，Git 可能删除原配置，或因个人修改而拒绝更新。请在拉取前停止工具，把 `config.toml` 复制到仓库外；如配置有未提交修改，确认备份后运行 `git restore -- config.toml`，再 `git pull --ff-only`。最后把备份放回项目根目录，后续就无需再做这一步。

**旧版首次升级到“本地提示词”版本：** 先停止工具，将 `prompts/images.md`、`prompts/copy.md` 复制到仓库外备份。旧版仍跟踪它们，Git 拉取本次更新可能删除原文件，或因个人修改而拒绝更新。确认备份后，如有未提交修改，执行 `git restore -- prompts/images.md prompts/copy.md`，再 `git pull --ff-only`，最后把两份备份恢复到原路径。此操作仅需一次；不要用模板覆盖自己的旧提示词。若同时跨越本地配置的版本，也按上一段保留配置。

更新前仍建议按上一节备份整个数据目录。不要用强制重置覆盖自己的提示词，也不要使用会清除忽略文件的 `git clean -fdx`，它会删除本地配置、实际提示词及素材。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 缺少 `config.toml` | 按上文复制 `config.toml.eaxmple` 并填写自己的代理；旧版升级用户恢复升级前备份，不要直接覆盖已有配置 |
| Windows 下 `npm.ps1` / `codex.ps1` 被阻止 | 在 PowerShell 使用 `npm.cmd` / `codex.cmd`；快捷 `.bat` 及后台会直接调用 npm 包的 JS 入口，无需放宽执行策略 |
| Windows 找不到 `curl` / PowerShell / `taskkill` | 使用 Windows 10/11 自带工具，检查系统 PATH；项目原生 Windows 入口不能混用仅装在 WSL 内的 Node/Codex |
| 找不到 `node` / Node 版本过低 | 安装 Node.js 24 或更新版本；新开终端检查 `node --version`。本项目使用 Node 内置 SQLite，旧版本不能运行 |
| 终端能运行，双击却找不到 Node 或 Codex | `nvm` / `fnm` 等管理器的路径可能只在交互终端加载。先在能正常运行 Node 的终端用 `npm run launch`；Codex 可通过 `codex_bin` 配置绝对路径 |
| `.command` 无执行权限或被当作文本打开 | 在项目终端执行 `chmod +x 启动素材工作台.command 停止素材工作台.command`，或直接运行 `bash ./启动素材工作台.command` |
| 下载依赖失败 | 确认代理软件已启动且配置地址正确；在已设置代理的项目终端执行 `npm ci`，根据报错处理后重新启动 |
| 登录检查失败 / 登录过期 | 在终端执行 `codex login`，用 ChatGPT 登录，再执行 `codex login status`。浏览器授权无法完成时参考官方认证文档中的设备登录方式；修复后恢复队列 |
| 模型不存在 / 生图工具不可用 | 检查当前账号、CLI 版本和模型权限。登录检查通过不等于具备工具权限。记录任务错误，确认 Codex 会话能实际生图；本项目不会自动切换 API 计费或用脚本画图替代 |
| 代理检查失败 | 核对 `config.toml` 中的协议与 HTTP / 混合端口，确认能访问 ChatGPT。代理响应不等于模型可用，仍需单选题验证 |
| 页面打不开 / 提示端口被占用 | 查看项目根目录 `startup.log`；若由本工具占用，重复启动应打开现有实例；若是其他软件占用，先停止本工具，再更改端口并启动 |
| 提示词检查失败 | 首次使用先将 `prompts/images.example.md`、`prompts/copy.example.md` 复制为 `images.md`、`copy.md`；已有用户恢复自己的备份。实际文件须可读且包含字面量 `{{topic}}` |
| 导入提示缺列或无数据 | 检查第一张工作表第一行的表头和数据；不要将标题、说明或空行放在表头之前 |
| 任务停在待审核 | 这是正常状态，需要人工通过才能进入下一阶段；不占并发名额 |
| 任务长时间无结果 / 出错 | 查看详情中的阶段和错误原因；检查账号额度、代理和 CLI 工具能力。限流时减少并发；超时和无效输出不会当作成功 |
| 修改配置或拉取代码后看不到变化 | 重复启动正在运行的服务只会打开页面。先执行停止脚本，再启动；修改提示词则在下一次新生成时生效 |
| 素材库为空 | 检查是否完成了图片、文案两次人工审核，以及账号 / 发布状态筛选和 `data_dir` 是否正确 |

排查时优先提供错误摘要与版本号。不要公开 Codex 登录凭据、含认证信息的代理地址或不愿分享的素材内容。

## 开发与验证

```sh
# 首次开发前，先按所在系统复制配置和两份提示词模板，再填写本地配置
npm ci
npm run build
npm test
npm start
```

执行前先停止后台实例，避免端口或数据锁冲突。`npm start` 在前台运行服务，用 `Ctrl+C` 退出；`npm run launch` 则在后台启动并打开浏览器。

生产构建由后端同时提供前端和 API，通过 SSE 推送任务状态。接口只接受本机 Host 和同源请求；SQLite 使用 Node 内置实现。CLI 子进程使用独立执行目录、临时会话和显式代理，移除 `OPENAI_API_KEY`、`CODEX_API_KEY`，强制 ChatGPT 登录；单个图片任务内部按顺序生成，不使用子代理。

历史构建、自动化测试与真实调用结果见 [验收记录](docs/验收记录.md)。自动化测试不能代替新用户对自己账号的真实生成验证。目前不包含跨机器同步、多人协作、自动发布到小红书或历史版本对比。
