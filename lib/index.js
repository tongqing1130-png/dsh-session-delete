/**
 * dsh-session-delete — 宿主（服务端）半边
 *
 * 提供一个 HTTP 路由：
 *   GET  /session-delete/api/list    列出会话（id / title / 磁盘路径），用于排查
 *   POST /session-delete/api/delete  { "sessionId": "..." } 真正删除会话目录
 *
 * 设计原则：DSH 内部服务名/方法名可能随版本变化，这里全部用「候选名 + 能力探测」
 * 的写法，拿不到服务就返回明确的 501 说明，而不是抛一半就死。
 */
import { rm, readdir, access, rename } from 'node:fs/promises'
import { dirname, resolve, basename, join } from 'node:path'
import { homedir } from 'node:os'

/** DSH 数据目录：优先环境变量，回退 ~/.dsh */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/** 等待 ms 毫秒 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 客户端（浏览器）半边上报的握手/诊断记录，只留最近 20 条 */
const CLIENT_REPORTS = []
function noteClientReport(entry) {
  CLIENT_REPORTS.push({ at: new Date().toISOString(), ...entry })
  if (CLIENT_REPORTS.length > 20) CLIENT_REPORTS.shift()
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 不依赖任何 DSH 服务的磁盘兜底定位：$DSH_HOME/sessions/<工作区键>/<sessionId>/
 * 目录名就是会话 id，因此逐个工作区目录拼一下即可，便宜且稳。
 */
async function findSessionDir(id) {
  let workspaces = []
  try {
    workspaces = await readdir(SESSIONS_ROOT)
  } catch {
    return null
  }
  for (const ws of workspaces) {
    const dir = join(SESSIONS_ROOT, ws, id)
    if (await exists(dir)) return dir
  }
  return null
}

/** Windows 上文件句柄未释放时 rm/rename 会 EBUSY/EPERM，退避重试 */
async function rmWithRetry(dir, tries = 8) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return { removed: true }
    } catch (err) {
      last = err
      const code = err?.code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY') throw err
      await sleep(150 + i * 120)
    }
  }
  // 最后手段：改名成待清理目录，避免它继续出现在会话列表里
  try {
    const grave = `${dir}.deleting-${Date.now()}`
    await rename(dir, grave)
    return { removed: false, pending: grave, reason: last?.code ?? String(last) }
  } catch {
    throw last
  }
}

export const name = 'dsh-session-delete'
export const inject = ['webServer']

const TAG = '[session-delete]'
const ID_RE = /^[A-Za-z0-9._:@-]{3,200}$/
const ROUTE = '/session-delete'

const PERSISTENCE_KEYS = ['sessionPersistence', 'sessionStore', 'persistence', 'sessionFiles']

function log(ctx, level, ...args) {
  try {
    const l = ctx.logger
    if (l && typeof l[level] === 'function') l[level](TAG, ...args)
    else console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](TAG, ...args)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function get(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

function pick(ctx, keys) {
  for (const k of keys) {
    const v = get(ctx, k)
    if (v) return v
  }
  return undefined
}

function persistenceOf(ctx) {
  const p = pick(ctx, PERSISTENCE_KEYS)
  if (p && typeof p.locate === 'function') return p
  // 有些版本把 locate 挂在 store 上
  const store = get(ctx, 'sessions')?.store
  if (store && typeof store.locate === 'function') return store
  return p
}

function headerId(h) {
  return h?.id ?? h?.sessionId ?? h?.header?.id ?? h?.meta?.id ?? undefined
}

function headerTitle(h) {
  return h?.title ?? h?.header?.title ?? h?.meta?.title ?? h?.summary ?? ''
}

async function listHeaders(p) {
  if (!p) return []
  const fn = p.list ?? p.headers ?? p.all
  if (typeof fn !== 'function') return []
  const out = await fn.call(p)
  if (Array.isArray(out)) return out
  if (out && Array.isArray(out.headers)) return out.headers
  if (out && typeof out[Symbol.iterator] === 'function') return [...out]
  return []
}

async function locatePath(p, header) {
  const fn = p?.locate
  if (typeof fn !== 'function') return null
  const loc = await fn.call(p, header)
  if (!loc) return null
  if (typeof loc === 'string') return loc
  return loc.path ?? loc.file ?? loc.filePath ?? loc.dir ?? null
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

function send(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 会话目录必须是 $DSH_HOME/sessions/<工作区键>/<会话id> 这种两层结构：
 * 只允许删「会话根目录的直接孙子」，因此向上删到别的目录不可能发生。
 * 目录名允许是会话 id 原文，也允许是 DSH 的 ~XXXX 编码形式（IM 会话 id 带 : 与 @）。
 */
function assertSafeDir(dir, id) {
  const abs = resolve(dir)
  const name = basename(abs)
  if (!name || name === '.' || name === '..') throw new Error(`refuse to delete suspicious directory: ${abs}`)
  const workspaceDir = dirname(abs)
  const root = dirname(workspaceDir)
  if (resolve(root) !== resolve(SESSIONS_ROOT)) {
    throw new Error(`refuse to delete directory outside sessions root: ${abs}`)
  }
  const lowered = name.toLowerCase()
  const looksLikeSession =
    lowered.includes(id.toLowerCase()) ||
    lowered.startsWith('session-') ||
    lowered.startsWith('im~') ||
    lowered.includes('~00')
  if (!looksLikeSession) throw new Error(`refuse to delete suspicious directory: ${abs}`)
  return abs
}

async function deleteSession(ctx, id, opts = {}) {
  const p = persistenceOf(ctx)

  // list() 返回的是 snapshot（{ header, revision, ... }），locate() 要的是 header 本体
  let snapshot
  if (p) {
    try {
      const headers = await listHeaders(p)
      snapshot = headers.find((h) => headerId(h) === id)
    } catch (err) {
      log(ctx, 'warn', 'list failed:', err?.message ?? err)
    }
  }
  const meta = snapshot?.header ?? snapshot

  // 服务层找不到也不算失败：磁盘兜底会再确认一次存在性
  let dir = await findSessionDir(id)
  const live = get(ctx, 'sessions')?.get?.(id)
  if (!snapshot && !dir && !live && !opts.force) throw new Error(`session not found: ${id}`)

  // 1) 活跃会话先停掉，否则文件句柄还在写
  const agents = get(ctx, 'agents')
  let cancelled = false
  try {
    const agent = agents?.get?.(id)
    if (agent && typeof agent.cancel === 'function') {
      await agent.cancel({ kind: 'user' }, { keepInbox: false })
      cancelled = true
      log(ctx, 'log', 'cancelled agent for', id)
    }
  } catch (err) {
    log(ctx, 'warn', 'cancel failed (继续删除):', err?.message ?? err)
  }

  // 2) 从会话表里摘掉活跃实例：detach() 会 emit session/disposed，
  //    前端据此刷新列表 —— 这是「不用重启 DSH」的关键
  const sessions = get(ctx, 'sessions')
  let detached = false
  try {
    const session = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
    let entry
    if (session) {
      try {
        if (typeof sessions.liveEntryFor === 'function') entry = sessions.liveEntryFor(session)
      } catch (err) {
        log(ctx, 'warn', 'liveEntryFor failed:', err?.message ?? err)
      }
    }
    if (!entry) entry = sessions?.store?.get?.(id)
    if (entry && typeof entry.detach === 'function') {
      entry.detach()
      detached = true
      log(ctx, 'log', 'detached live session', id)
    }
  } catch (err) {
    log(ctx, 'warn', 'detach failed (继续删除):', err?.message ?? err)
  }

  // 3) 定位磁盘路径：先看服务层，再用磁盘扫描（detach 后可能出现新目录）
  if (!dir && typeof p?.locate === 'function' && meta) {
    try {
      const loc = await p.locate(meta)
      const file = typeof loc === 'string' ? loc : loc?.path ?? loc?.file ?? null
      if (file) dir = dirname(resolve(file))
    } catch (err) {
      log(ctx, 'warn', 'persistence.locate failed:', err?.message ?? err)
    }
  }
  if (!dir) dir = await findSessionDir(id)

  // 纯内存会话（还没落盘）到这里就没有目录可删了
  if (!dir) {
    return {
      ok: true,
      sessionId: id,
      removed: null,
      memoryOnly: true,
      cancelled,
      detached,
    }
  }

  assertSafeDir(dir, id)

  // 4) 真正删目录（归档只是打标记，这里是从磁盘上抹掉）
  const outcome = await rmWithRetry(dir)
  log(ctx, 'log', 'removed', dir, outcome.removed ? '' : `(pending rename → ${outcome.pending})`)

  // 5) 让持久化层忘掉这条记录（不同版本方法名不同，能调就调）
  for (const method of ['remove', 'forget', 'delete', 'removeHeader']) {
    if (typeof p?.[method] !== 'function') continue
    try {
      await p[method](meta ?? id)
      break
    } catch (err) {
      log(ctx, 'warn', `persistence.${method} failed (目录已删):`, err?.message ?? err)
    }
  }

  // 6) 清理工作区登记表：走官方方法，才会 emit 变更事件
  try {
    const reg = get(ctx, 'workspaceRegistry')
    for (const method of ['unarchiveSession', 'unpinSession']) {
      if (typeof reg?.[method] !== 'function') continue
      try {
        await reg[method](id)
      } catch (err) {
        log(ctx, 'warn', `${method} failed:`, err?.message ?? err)
      }
    }
    const list = typeof reg?.list === 'function' ? reg.list() : []
    for (const ws of Array.isArray(list) ? list : []) {
      if (typeof ws?.detachSession !== 'function') continue
      try {
        await ws.detachSession(id)
      } catch (err) {
        log(ctx, 'warn', 'workspace detachSession failed:', err?.message ?? err)
      }
    }
  } catch (err) {
    log(ctx, 'warn', 'workspace cleanup failed (不影响删除):', err?.message ?? err)
  }

  return {
    ok: true,
    sessionId: id,
    removed: dir,
    diskRemoved: outcome.removed,
    pending: outcome.pending ?? null,
    cancelled,
    detached,
  }
}

class NotImplemented extends Error {
  constructor(message) {
    super(message)
    this.code = 501
  }
}

function makeHandler(ctx) {
  return async function handler(req, res) {
    try {
      const host = String(req.headers?.host ?? '')
      const hostname = host.replace(/:\d+$/, '')
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
        send(res, 403, { ok: false, error: 'localhost only' })
        return
      }

      const url = new URL(req.url, 'http://localhost')
      const tail = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : url.pathname

      if (req.method === 'GET' && /^\/api\/list\/?$/.test(tail)) {
        const p = persistenceOf(ctx)
        const headers = await listHeaders(p)
        const items = []
        for (const h of headers) {
          let path = null
          try {
            path = await locatePath(p, h)
          } catch {
            /* 忽略单条失败 */
          }
          if (!path) {
            try {
              path = await findSessionDir(headerId(h))
            } catch {
              /* 忽略 */
            }
          }
          items.push({ id: headerId(h), title: headerTitle(h), path, onDisk: Boolean(path) })
        }
        // 服务层拿不到列表时，直接扫磁盘
        if (!items.length) {
          try {
            for (const ws of await readdir(SESSIONS_ROOT)) {
              const wsDir = join(SESSIONS_ROOT, ws)
              let entries = []
              try {
                entries = await readdir(wsDir, { withFileTypes: true })
              } catch {
                continue
              }
              for (const e of entries) {
                if (!e.isDirectory()) continue
                if (e.name.includes('.deleting-')) continue
                items.push({ id: e.name, title: '', path: join(wsDir, e.name), onDisk: true, workspace: ws })
              }
            }
          } catch {
            /* 无磁盘目录时忽略 */
          }
        }

        send(res, 200, { ok: true, count: items.length, items })
        return
      }

      if (req.method === 'GET' && /^\/api\/ping\/?$/.test(tail)) {
        send(res, 200, { ok: true, plugin: name, build: 'v4-encoded-dir', routes: ['/api/list', '/api/delete'] })
        return
      }

      if (req.method === 'POST' && /^\/api\/delete\/?$/.test(tail)) {
        const raw = await readBody(req)
        let payload = {}
        try {
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const id = String(payload.sessionId ?? payload.id ?? '').trim()
        if (!id || !ID_RE.test(id)) {
          send(res, 400, { ok: false, error: 'invalid sessionId' })
          return
        }
        const result = await deleteSession(ctx, id, { force: payload.force === true })
        send(res, 200, result)
        return
      }

      if (req.method === 'POST' && /^\/api\/hello\/?$/.test(tail)) {
        const raw = await readBody(req, 8 * 1024)
        let payload = {}
        try {
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          payload = { raw: raw.slice(0, 200) }
        }
        noteClientReport(payload)
        log(ctx, 'log', 'client report:', JSON.stringify(payload).slice(0, 300))
        send(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && /^\/api\/debug\/?$/.test(tail)) {
        let workspaces = []
        try {
          workspaces = await readdir(SESSIONS_ROOT)
        } catch (err) {
          workspaces = [`ERR: ${err?.code ?? err?.message}`]
        }
        send(res, 200, {
          ok: true,
          dshHome: DSH_HOME,
          sessionsRoot: SESSIONS_ROOT,
          rootExists: await exists(SESSIONS_ROOT),
          workspaces,
          persistenceKeys: PERSISTENCE_KEYS.filter((k) => Boolean(get(ctx, k))),
          services: ['sessions', 'agents', 'workspaceRegistry'].filter((k) => Boolean(get(ctx, k))),
          clientReports: CLIENT_REPORTS,
        })
        return
      }

      send(res, 404, { ok: false, error: `unknown route: ${req.method} ${tail}` })
    } catch (err) {
      const code = err?.code === 501 ? 501 : 500
      log(ctx, 'error', err?.stack ?? String(err))
      if (!res.headersSent) send(res, code, { ok: false, error: err?.message ?? String(err), detail: String(err?.stack ?? '').split(String.fromCharCode(10)).slice(0, 6) })
    }
  }
}

export function apply(ctx) {
  const handler = makeHandler(ctx)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler,
      }),
    'dsh-session-delete:route',
  )
  log(ctx, 'log', 'ready →', `${ROUTE}/api/delete`)
}