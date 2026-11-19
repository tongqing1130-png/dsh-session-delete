# dsh-session-delete

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的会话列表加一个「**删除对话**」——真的删掉，不是归档。

DSH 原生只能「归档」会话，归档后日志仍留在磁盘上。这个插件在会话右键菜单里插一项**删除对话**：原生 `MenuItemButton` 危险色 + 原生 `Modal` 二次确认，确认后把会话从**磁盘目录、内存会话表、工作区引用**三处一起清掉，列表即时消失，**不用重启 DSH**。

```
右键会话 → 🗑 删除对话 → 「彻底删除这个对话？」→ 删除对话
```

## 安装

### 方式一：插件市场（推荐）

设置 → 插件市场 → 搜索 `dsh-session-delete` → 安装 → 重启一次 DSH。

装好后它出现在「已安装」列表里，右侧开关可随时**开 / 关**（热切换，不用重启）。

### 方式二：手动挂载（本地开发）

```bash
cd ~/.dsh/profiles/desktop                  # Windows: C:\Users\<你>\.dsh\profiles\desktop
mkdir -p local-plugins && cd local-plugins
git clone https://github.com/tongqing1130-png/dsh-session-delete.git
```

在 profile 的 `package.json` 里加依赖（`link:` 让 `node_modules` 变软链，改源码立即生效）：

```json
{
  "dependencies": {
    "dsh-session-delete": "link:./local-plugins/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-session-delete"]
    }
  }
}
```

再在 profile 根目录 `cordis.patch.yml` 末尾追加一行覆盖行（**不要**写 `- insert:`，会和包自带的 insert 重复挂载导致 404）：

```yaml
- id: dsh-session-delete
  disabled: false
```

然后 `pnpm install`，重启 DSH。

## 它是怎么删的

| 步骤 | 做什么 |
|---|---|
| 1 | `agents.get(id).cancel()` —— 会话还在跑就先取消 |
| 2 | `sessions.liveEntryFor(...).detach()` —— 从内存会话表移除并广播 `session/disposed` |
| 3 | 定位磁盘目录：扫 `sessions/*/<id>`；IM 会话的 id 含 `:` `@`，目录名是 `im~003A...` 编码形式，靠 `persistence.locate()` 兜底 |
| 4 | `assertSafeDir()` 结构校验：**只允许删 `$DSH_HOME/sessions/<工作区键>/<会话 id>` 这一层**，其余一律拒 |
| 5 | `rmWithRetry()`：EBUSY / EPERM / EACCES / ENOTEMPTY 退避重试 8 次，仍失败则改名成 `<dir>.deleting-<ts>`，不阻塞后续 |
| 6 | 工作区清理：`registry.unarchiveSession()` / `unpinSession()` + 逐实体 `ws.detachSession()` |
| 7 | 纯内存、尚未落盘的会话直接按 `memoryOnly: true` 算删成功 |

会话 id 只接受 `^[A-Za-z0-9._:@-]{3,200}$`。

### 访问校验（v1.1.1 起）

路由挂在 DSH 的 web 端口上。DSH 自己的 web 服务器已经会拦未授权的请求（实测外部 `curl` 直接拿到 401/403），但那属于宿主的行为，插件不该把安全押在别人的实现上 —— 所以插件自己再加三道闸：

| 闸 | 规则 | 挡住的场景 |
|---|---|---|
| 令牌 | 除 `/api/ping`、`/api/token` 外，请求必须带 `x-session-delete-token`，值等于本进程随机生成的 24 字节令牌（`timingSafeEqual` 比较） | 别的网页盲发 POST —— 它读不到令牌 |
| 来源 | 有 `Sec-Fetch-Site: cross-site` 或 `same-site` 一律 403；有 `Origin` 时必须匹配 `http(s)://(127.0.0.1\|localhost\|[::1])(:port)?` | 跨站表单/`fetch` 打进来的请求 |
| 类型 | `/api/delete` 必须 `content-type: application/json` | 不需要预检的「简单请求」（form、`text/plain`） |

令牌为什么拿得到、却偷不走：插件**不返回任何 CORS 头**。同源的 DSH 页面可以 `fetch` 到 `/api/token` 并读到值；别的源的网页能发出请求，但浏览器不让它读响应体，于是拿不到令牌，后续所有调用都被 403。

客户端侧（`lib/client.js`）第一次删除前会取一次令牌并缓存；宿重重载换了令牌时收到 403 会自动重取一次再试，用户无感。

## HTTP 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/session-delete/api/ping` | 免 | 存活探针，返回 `build` 标记与 `auth: 'token'` |
| GET | `/session-delete/api/token` | 同源 | 发令牌（`{ token }`），仅供同源客户端读取 |
| GET | `/session-delete/api/list` | 令牌 | 会话清单（id / 标题 / 磁盘路径 / onDisk） |
| POST | `/session-delete/api/delete` | 令牌 + JSON | `{ sessionId }` → `{ ok, removed, diskRemoved, memoryOnly?, cancelled, detached }` |

浏览器控制台兜底：`__dshListSessions()` / `__dshDeleteSession(id)`。

## 目录结构

```
dsh-session-delete/
├─ package.json          dsh.bundle + dsh.client 声明，市场识别用
├─ cordis.patch.yml      bundle 层挂载行（insert id = dsh-session-delete）
├─ icon.svg              市场卡片图标（跟随主题色）
├─ lib/index.js          宿主半边：HTTP 路由 + 删除逻辑
├─ lib/client.js        界面半边：插槽菜单项 + 原生确认框
├─ INSTALL.md           安装与结构详解（含市场三件套规则）
└─ LICENSE              MIT
```

## 改代码后的生效方式

- **界面半边** `lib/client.js`：浏览器 `Ctrl+Shift+R` 硬刷新。
- **宿主半边** `lib/index.js`：改 `package.json` 或 `cordis.patch.yml` 的**内容**触发 HMR reconcile（只 `touch` 改 mtime 会被跳过）；涉及 ESM 缓存时重启 DSH 最稳。

## 兼容

- DSH `>= 0.2`（用到 `sessions.liveEntryFor` / `slots` / `shell.overlay` 插槽）
- Node `>= 20`，无第三方依赖

## License

MIT © 2026 Dizrt1001

## 从 tarball 安装（插件市场 / 手动）

```
https://github.com/tongqing1130-png/dsh-session-delete/releases/download/v1.1.2/dsh-session-delete-1.1.2.tgz
```

包里是 `npm pack` 布局（所有文件在 `package/` 下），并且地址带版本号 —— `latest/download` 在换资产后会指向别的文件，条目里一律用带 tag 的地址。
