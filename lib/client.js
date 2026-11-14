window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;
    const Fragment = react.Fragment;
    const useState = react.useState;
    const useEffect = react.useEffect;

    /** Host side of this plugin: POST /session-delete/api/delete */
    const ENDPOINT = "/session-delete/api/delete";
    const MENU_SLOT = "sidebar.workspaces.session.menu.item";
    const OVERLAY_SLOT = "shell.overlay";
    const LABEL = "删除对话";
    const DANGER_CLASS = "dsh-session-delete-danger";
    const DANGER_CSS =
      "." +
      DANGER_CLASS +
      ":not(:disabled){color:var(--dsw-alias-state-error-primary)}";

    const MUTED_STYLE = {
      color: "var(--dsw-alias-label-secondary)",
      fontSize: "12px",
      lineHeight: "18px",
    };
    const ERROR_STYLE = {
      color: "var(--dsw-alias-state-error-primary)",
      marginTop: "8px",
      fontSize: "12px",
      lineHeight: "18px",
    };

    let serviceCtx;

    function warn(message, error) {
      try {
        console.warn("[session-delete]", message, error ?? "");
      } catch {}
    }

    async function callDelete(sessionId) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    }

    /** The Host already disposed the Session: only the list row has to go. */
    function afterDeleted(sessionId) {
      if (String(window.location.href).includes(sessionId)) {
        window.setTimeout(() => window.location.reload(), 60);
        return;
      }
      try {
        serviceCtx?.sessions?.refresh?.();
      } catch (error) {
        warn("refresh failed", error);
      }
    }

    /** Pending request shared by the menu row and the overlay dialog. */
    const pending = {
      value: null,
      listeners: new Set(),
      get() {
        return this.value;
      },
      set(next) {
        this.value = next;
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch (error) {
            warn("listener failed", error);
          }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };

    /** Native menu row: same primitive, icon and danger token as the built-ins. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const setMenuOpen = useMenuOpenState()[1];
      return jsx(primitives.MenuItemButton, {
        danger: true,
        icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false);
          pending.set({ sessionId, title: displayTitle || sessionId });
        },
        children: LABEL,
      });
    }

    /** Native confirmation dialog mounted through `shell.overlay`. */
    function DeleteSessionDialog() {
      const [request, setRequest] = useState(pending.get());
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      useEffect(() => {
        setRequest(pending.get());
        return pending.subscribe(() => {
          setRequest(pending.get());
          setError(null);
        });
      }, []);

      const close = () => {
        if (busy) return;
        pending.set(null);
      };

      const confirm = async () => {
        if (request === null || busy) return;
        const sessionId = request.sessionId;
        setBusy(true);
        setError(null);
        try {
          await callDelete(sessionId);
        } catch (reason) {
          setBusy(false);
          setError(reason instanceof Error ? reason.message : String(reason));
          return;
        }
        setBusy(false);
        pending.set(null);
        afterDeleted(sessionId);
      };

      const footer = jsxs(Fragment, {
        children: [
          jsx(primitives.Button, {
            variant: "outline",
            disabled: busy,
            onClick: close,
            children: "取消",
          }),
          jsx(primitives.Button, {
            variant: "outline",
            className: DANGER_CLASS,
            disabled: busy,
            onClick: confirm,
            children: LABEL,
          }),
        ],
      });

      const body = [];
      if (busy) body.push(jsx("div", { style: MUTED_STYLE, role: "status", children: "正在删除…" }));
      if (error !== null) body.push(jsx("div", { style: ERROR_STYLE, role: "alert", children: error }));

      return jsx(primitives.Modal, {
        open: request !== null,
        onClose: close,
        closeLabel: "关闭",
        title: "彻底删除这个对话？",
        description:
          request === null
            ? undefined
            : `「${request.title}」的会话日志会从磁盘上删除，不会进入“已归档”，删除后无法恢复。`,
        footer,
        children: body.length === 0 ? null : jsxs(Fragment, { children: body }),
      });
    }

    function apply(ctx) {
      serviceCtx = ctx;

      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin", "dsh-session-delete");
        style.textContent = DANGER_CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, "dsh-session-delete: danger button css");

      ctx.effect(
        () =>
          ctx.slots.inject(MENU_SLOT, () =>
            ctx.slots.register(
              { name: MENU_SLOT, id: "session-delete", order: 500 },
              DeleteSessionMenuItem,
            ),
          ),
        "dsh-session-delete: menu row",
      );

      ctx.effect(
        () =>
          ctx.slots.inject(OVERLAY_SLOT, () =>
            ctx.slots.register(
              { name: OVERLAY_SLOT, id: "session-delete-dialog" },
              DeleteSessionDialog,
            ),
          ),
        "dsh-session-delete: confirm dialog",
      );

      try {
        window.__dshDeleteSession = (sessionId, title) =>
          pending.set({ sessionId, title: title || sessionId });
      } catch {}
    }

    const name = "dsh-session-delete";
    const inject = ["slots", "sessions", "connection"];

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});