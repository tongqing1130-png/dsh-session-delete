# dsh-session-delete · 安装与结构说明

给 DSH 会话列表加一个「**删除对话**」菜单项：真正删掉会话（磁盘目录 + 内存条目 + 工作区引用），而不是归档。
走 DSH 原生 UI（`MenuItemButton` + `Modal` + `Button`），危险色由原生 CSS 变量驱动，跟随主题。

---

## 1. 它现在的安装形态（插件市场可开关）

按插件市场（dshmarket）的识别规则，一个能被「打开 / 关闭」的插件必须同时满足三件事，本插件已全部满足：

| 市场要求 | 本插件位置 |
|---|---|
| 出现在 profile 的 `package.json` `dependencies` | `"dsh-session-delete": "link:./local-plugins/dsh-session-delete"` |
| 出现在 `dsh.profile.bundles`（bundle 层） | 列表末尾有 `"dsh-session-delete"` |
| 自带 `dsh.bundle.patch`，且行 id 可在用户 patch 层被改写 | `cordis.patch.yml` → `- insert: - id: dsh-session-delete` |

profile 根目录 `cordis.patch.yml` 里只有一行覆盖行，**不要**再写 `- insert:`（会与 bundle 自带的 insert 重复挂载 → 插件 404）：

```yaml
- id: dsh-session-delete
  disabled: false      # 市场关掉时会写成 true
```

开 / 关的持久化由市场负责：live 切换走 loader entry 的 `disabled`，落盘写 `dsh.profile.bundles` + 上面的 patch 行，并记进 `.dsh-market/state.json` 的 `disabled`。

---

## 2. 目录结构

```
<profile>/local-plugins/dsh-session-delete/     ← 唯一源码位置（node_modules 里是软链）
├─ package.json          name/version/description/icon/keywords + dsh.bundle + dsh.client
├─ icon.svg              市场卡片图标
├─ cordis.patch.yml      bundle 层挂载行（insert id = dsh-session-delete）
├─ lib/index.js          宿主半边：HTTP 路由 + 真删除逻辑
├─ lib/client.js         界面半边：插槽菜单项 + 原生确认框
└─ README-安装.md        本文件
```

`node_modules/dsh-session-delete` 是指向它的软链，改源码立刻反映，无需再同步副本。

---

## 3. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/session-delete/api/ping` | 存活探针，返回 `build` 版本标记 |
| GET | `/session-delete/api/list` | 列出会话（id / 标题 / 磁盘路径 / onDisk） |
| POST | `/session-delete/api/delete` | `{sessionId}` → 删除；返回 `{ok, removed, diskRemoved, memoryOnly?, cancelled, detached}` |
| GET | `/session-delete/api/debug` | 运行环境与客户端上报 |
| POST | `/session-delete/api/hello` | 客户端自检上报 |

只接受 localhost Host。控制台兜底：`__dshListSessions()` / `__dshDeleteSession(id)`。

---

## 4. 删除到底做了什么

1. `agents.get(id).cancel(...)` —— 正在跑的会话先取消；
2. `sessions.get(id)` → `sessions.liveEntryFor(...)` → `entry.detach()` —— 从内存会话表移除；
3. 定位磁盘目录（`findSessionDir` 扫 `sessions/*/<id>`；IM 会话的 id 带 `:`、`@`，目录名是 `im~003A...` 编码形式，靠 `locate()` 兜底）；
4. `assertSafeDir` 结构校验：**只允许删 `$DSH_HOME/sessions/<工作区键>/<会话id>` 这一层**；
5. `rmWithRetry` 删除，EBUSY/EPERM 退避重试，最后失败则 `rename` 成 `<dir>.deleting-<ts>` 不阻塞；
6. 工作区清理：`registry.unarchiveSession` / `unpinSession` + 逐实体 `ws.detachSession`；
7. 纯内存、未落盘的会话直接按 `memoryOnly: true` 算删成功。

---

## 5. 修改代码后的生效方式

- **界面半边**（`lib/client.js`）：浏览器 `Ctrl+Shift+R` 硬刷新即可。
- **宿主半边**（`lib/index.js`）：改 `package.json` 或 `cordis.patch.yml` 的**内容**触发 HMR reconcile；只 `touch`（mtime 变、内容不变）会被跳过。
- 若某次改动涉及 ESM 缓存，重启一次 DSH 最稳妥。