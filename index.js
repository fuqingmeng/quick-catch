/*
 * quick-catch - 一键记事 / One-tap note
 * 快捷键由用户在「设置 → 快捷键 → 插件」中自行设置，设置后在任意地方唤出悬浮记事面板，
 * 确认后直接写入默认笔记本。仅 Windows 支持。面板为独立的置顶小窗口：不打断当前操作。
 */
const {Plugin, Dialog, showMessage, fetchSyncPost, getFrontend} = require("siyuan");

const STORAGE_KEY = "config.json";
const COMMAND_QUICK_NOTE = "globalQuickNote";

const escapeHtml = (text) => {
    return String(text).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[char]));
};

const pad = (num) => String(num).padStart(2, "0");

module.exports = class QuickCatch extends Plugin {
    async onload() {
        this.config = {};
        try {
            const data = await this.loadData(STORAGE_KEY);
            if (typeof data === "string") {
                this.config = JSON.parse(data) || {};
            } else if (data && typeof data === "object") {
                this.config = data;
            }
        } catch (e) {
            console.warn(`[${this.name}] load config failed:`, e);
        }
        const frontend = getFrontend();
        this.isMobile = frontend === "mobile" || frontend === "browser-mobile";

        this.addIcons(`<symbol id="qcBolt" viewBox="0 0 32 32">
<path d="M19 3L8 17h6l-2 12 13-16h-7l1-10z"/>
</symbol>`);

        // 全局快捷键：无默认值，由用户在「设置 → 快捷键 → 插件」中自行设置后生效
        this.addCommand({
            langKey: COMMAND_QUICK_NOTE,
            hotkey: "",
            globalCallback: () => {
                this.showQuickNote();
            },
        });
        const keymap = window.siyuan.config && window.siyuan.config.keymap && window.siyuan.config.keymap.plugin &&
            window.siyuan.config.keymap.plugin[this.name] && window.siyuan.config.keymap.plugin[this.name][COMMAND_QUICK_NOTE];
        this.quickNoteHotkey = (keymap && keymap.custom) || "";

        this.quickNotePanelWin = null;
        this.initQuickNoteIpc();
    }

    // 布局就绪后：顶栏加入按钮，点击设定默认笔记本
    onLayoutReady() {
        this.quickCatchButton = this.addTopBar({
            icon: `<svg><use xlink:href="#qcBolt"></use></svg>`,
            title: this.i18n.settingsTooltip,
            position: "right",
            callback: () => {
                this.showSettingsPanel();
            },
        });
    }

    onunload() {
        this.uninitQuickNoteIpc();
        if (this.quickCatchButton) {
            try {
                this.quickCatchButton.remove();
            } catch (e) {
                console.warn(`[${this.name}] remove top bar button failed:`, e);
            }
            this.quickCatchButton = null;
        }
        if (this.quickNotePanelWin) {
            try {
                this.quickNotePanelWin.destroy();
            } catch (e) {
                console.warn(`[${this.name}] destroy quick note panel failed:`, e);
            }
            this.quickNotePanelWin = null;
        }
    }

    /* ---------- 全局速记 ---------- */

    showQuickNote() {
        if (!this.config.quickNoteNotebook) {
            showMessage(this.i18n.quickNoteNotConfigured, 5000);
            this.showSettingsPanel();
            return;
        }
        if (this.quickNotePanelWin) {
            // 面板已打开时将其唤起到前台
            try {
                this.quickNotePanelWin.focus();
            } catch (e) {
                console.warn(`[${this.name}] focus quick note panel failed:`, e);
            }
            return;
        }
        if (!this.openQuickNotePanel()) {
            this.showQuickNoteDialog();
        }
    }

    // 独立悬浮面板：思源主窗口保持后台不跳转（仅桌面端可用）
    openQuickNotePanel() {
        let remote;
        try {
            remote = window.require("@electron/remote");
        } catch (e) {
            return false;
        }
        if (!remote || !remote.BrowserWindow) {
            return false;
        }
        try {
            const mainWinId = remote.getCurrentWindow().id;
            const b3Vars = this.collectB3Vars();
            const width = 400;
            const height = 270;
            // 恢复上次拖动后的位置；若已不在任何屏幕范围内则回退到默认位置
            const saved = this.config.quickNotePos;
            let x = null;
            let y = null;
            if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
                const onScreen = remote.screen.getAllDisplays().some((display) => {
                    const area = display.workArea;
                    return saved.x >= area.x - 100 && saved.x <= area.x + area.width &&
                        saved.y >= area.y - 100 && saved.y <= area.y + area.height;
                });
                if (onScreen) {
                    x = saved.x;
                    y = saved.y;
                }
            }
            if (x === null || y === null) {
                const display = remote.screen.getDisplayMatching(remote.getCurrentWindow().getBounds());
                x = display.workArea.x + display.workArea.width - width - 24;
                y = display.workArea.y + display.workArea.height - height - 24;
            }
            const panelHtml = this.buildQuickNotePanelHtml(mainWinId, b3Vars);
            const dataUrl = "data:text/html;charset=utf-8;base64," +
                btoa(unescape(encodeURIComponent(panelHtml)));
            const win = new remote.BrowserWindow({
                width: width,
                height: height,
                x: x,
                y: y,
                frame: false,
                resizable: false,
                fullscreenable: false,
                maximizable: false,
                alwaysOnTop: true,
                skipTaskbar: true,
                show: false,
                backgroundColor: b3Vars["--b3-theme-surface"] || "#3a3a3a",
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    webSecurity: false,
                },
            });
            // 在主进程中启用该窗口的 @electron/remote，供面板内脚本与主窗口通信
            remote.require("@electron/remote/main").enable(win.webContents);
            win.loadURL(dataUrl);
            win.show();
            // 拖动时（防抖）与关闭时保存面板位置
            let moveTimer = null;
            win.on("move", () => {
                if (moveTimer) {
                    clearTimeout(moveTimer);
                }
                moveTimer = setTimeout(() => {
                    this.saveQuickNotePos(win);
                }, 800);
            });
            win.on("close", () => {
                if (moveTimer) {
                    clearTimeout(moveTimer);
                }
                this.saveQuickNotePos(win);
                if (this.quickNotePanelWin === win) {
                    this.quickNotePanelWin = null;
                }
            });
            win.on("closed", () => {
                if (this.quickNotePanelWin === win) {
                    this.quickNotePanelWin = null;
                }
            });
            this.quickNotePanelWin = win;
            return true;
        } catch (e) {
            console.warn(`[${this.name}] open quick note panel failed:`, e);
            return false;
        }
    }

    saveQuickNotePos(win) {
        try {
            const pos = win.getPosition();
            if (Array.isArray(pos) && pos.length === 2 && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
                this.config.quickNotePos = {x: pos[0], y: pos[1]};
                this.saveConfig();
            }
        } catch (e) {
            console.warn(`[${this.name}] save quick note position failed:`, e);
        }
    }

    // 收集当前主题的全部 --b3-* CSS 变量，注入速记面板使配色与思源一致
    collectB3Vars() {
        const vars = {};
        try {
            const styles = getComputedStyle(document.documentElement);
            for (let i = 0; i < styles.length; i++) {
                const name = styles[i];
                if (name && name.indexOf("--b3-") === 0) {
                    vars[name] = styles.getPropertyValue(name).trim();
                }
            }
        } catch (e) {
            console.warn(`[${this.name}] collect b3 vars failed:`, e);
        }
        return vars;
    }

    buildQuickNotePanelHtml(mainWinId, b3Vars) {
        const varsCss = Object.keys(b3Vars).map((name) => {
            return `${name}: ${b3Vars[name]};`;
        }).join("\n");
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
${varsCss}
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
    font-family: var(--b3-font-family, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
    font-size: var(--b3-font-size, 14px);
    background-color: var(--b3-theme-surface, #ffffff);
    color: var(--b3-theme-on-background, #1e1e1e);
    border: 1px solid var(--b3-theme-surface-lighter, rgba(0, 0, 0, 0.12));
    border-radius: var(--b3-border-radius-b, 4px);
    box-shadow: var(--b3-dialog-shadow, 0 8px 24px rgba(0, 0, 0, 0.3));
    display: flex;
    flex-direction: column;
    -webkit-app-region: drag;
}
.head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 24px;
    font-size: 16px;
    font-weight: 500;
    border-bottom: 1px solid var(--b3-theme-surface-lighter, rgba(0, 0, 0, 0.12));
}
.head .hint { font-size: 12px; font-weight: normal; opacity: 0.6; }
.content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 24px;
}
textarea {
    flex: 1;
    resize: none;
    outline: none;
    border: 1px solid var(--b3-theme-surface-lighter, rgba(0, 0, 0, 0.12));
    border-radius: var(--b3-border-radius, 4px);
    background-color: var(--b3-theme-background-light, rgba(128, 128, 128, 0.1));
    color: var(--b3-theme-on-background, #1e1e1e);
    padding: 8px 12px;
    font-size: var(--b3-font-size, 14px);
    line-height: 1.5;
    font-family: inherit;
}
textarea::placeholder { color: var(--b3-theme-on-background, #1e1e1e); opacity: 0.4; }
textarea:focus { border-color: var(--b3-theme-primary, #3575f0); }
.status {
    font-size: 12px;
    color: var(--b3-theme-error, #d23f31);
    min-height: 16px;
    text-align: right;
}
.actions { display: flex; gap: 8px; justify-content: flex-end; }
textarea, button, .status { -webkit-app-region: no-drag; }
button {
    border: 0;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--b3-font-size, 14px);
    border-radius: var(--b3-border-radius, 4px);
    padding: 4px 12px;
    transition: box-shadow 280ms ease;
}
#cancel {
    color: var(--b3-theme-on-surface, var(--b3-theme-on-background, #1e1e1e));
    background-color: transparent;
}
#cancel:hover, #cancel:focus { background-color: var(--b3-list-hover, rgba(128, 128, 128, 0.15)); }
#confirm {
    color: var(--b3-theme-on-primary, #ffffff);
    background-color: var(--b3-theme-primary, #3575f0);
}
#confirm:hover, #confirm:focus { box-shadow: var(--b3-button-shadow, none); }
#confirm:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
    <div class="head"><span>${this.i18n.quickNotePanelTitle}</span><span class="hint">${this.i18n.quickNoteHint}</span></div>
    <div class="content">
        <textarea id="input" placeholder="${this.i18n.quickNotePlaceholder}"></textarea>
        <div class="status" id="status"></div>
        <div class="actions">
            <button id="cancel">${this.i18n.cancel}</button>
            <button id="confirm">${this.i18n.confirm}</button>
        </div>
    </div>
<script>
(function () {
    var remote = require("@electron/remote");
    var ipcRenderer = require("electron").ipcRenderer;
    var win = remote.getCurrentWindow();
    var mainWin = function () {
        return remote.BrowserWindow.getAllWindows().find(function (w) { return w.id === ${mainWinId}; });
    };
    var send = function (channel, data) {
        try {
            var w = mainWin();
            if (w) { w.webContents.send(channel, data); return true; }
        } catch (e) {}
        return false;
    };
    var input = document.getElementById("input");
    var confirmBtn = document.getElementById("confirm");
    var cancelBtn = document.getElementById("cancel");
    var statusEl = document.getElementById("status");
    var submitting = false;
    var timer = null;
    var closePanel = function () {
        try { win.close(); } catch (e) {}
    };
    var posMsg = function () {
        try { return {pos: win.getPosition()}; } catch (e) { return {}; }
    };
    // 告知主窗口面板已就绪（winId 用于回执）
    send("dnt-quicknote-open", {winId: win.id});
    var submit = function () {
        if (submitting) { return; }
        var content = input.value.trim();
        if (!content) { input.focus(); return; }
        submitting = true;
        confirmBtn.disabled = true;
        confirmBtn.textContent = "${this.i18n.creating}";
        if (!send("dnt-quicknote-submit", {content: content, winId: win.id})) {
            statusEl.textContent = "${this.i18n.quickNoteConnFailed}";
            submitting = false;
            confirmBtn.disabled = false;
            confirmBtn.textContent = "${this.i18n.confirm}";
            return;
        }
        timer = setTimeout(function () {
            statusEl.textContent = "${this.i18n.quickNoteNoResponse}";
            submitting = false;
            confirmBtn.disabled = false;
            confirmBtn.textContent = "${this.i18n.confirm}";
        }, 15000);
    };
    confirmBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", function () {
        send("dnt-quicknote-close", posMsg());
        closePanel();
    });
    input.addEventListener("keydown", function (e) {
        // 输入法组词中的 Enter 不提交
        if (e.isComposing || e.keyCode === 229) { return; }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    });
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
            send("dnt-quicknote-close", posMsg());
            closePanel();
        }
    });
    window.addEventListener("beforeunload", function () {
        send("dnt-quicknote-close", posMsg());
    });
    ipcRenderer.on("dnt-quicknote-result", function (e, data) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (data && data.ok) {
            closePanel();
        } else {
            statusEl.textContent = (data && data.msg) ? data.msg : "${this.i18n.quickNoteFailed}";
            submitting = false;
            confirmBtn.disabled = false;
            confirmBtn.textContent = "${this.i18n.confirm}";
        }
    });
    input.focus();
})();
</script>
</div>
</body>
</html>`;
    }

    // 浏览器/移动端等无法使用独立窗口时的回退方案：在主窗口内弹面板
    showQuickNoteDialog() {
        if (this.quickNoteDialog) {
            return;
        }
        const dialog = new Dialog({
            title: this.i18n.quickNotePanelTitle,
            content: `<div class="b3-dialog__content dnt-quicknote">
    <textarea class="b3-text-field fn__block dnt-quicknote__input" rows="5" placeholder="${this.i18n.quickNotePlaceholder}"></textarea>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.i18n.cancel}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">${this.i18n.confirm}</button>
</div>`,
            width: this.isMobile ? "92vw" : "420px",
            destroyCallback: () => {
                this.quickNoteDialog = null;
            },
        });
        this.quickNoteDialog = dialog;
        const textarea = dialog.element.querySelector("textarea");
        const cancelButton = dialog.element.querySelector(".b3-button--cancel");
        const confirmButton = dialog.element.querySelector(".b3-button--text");

        cancelButton.addEventListener("click", () => {
            dialog.destroy();
        });
        const submit = async () => {
            const content = textarea.value.trim();
            if (!content) {
                showMessage(this.i18n.quickNoteEmpty, 4000);
                return;
            }
            confirmButton.disabled = true;
            confirmButton.textContent = this.i18n.creating;
            const ok = await this.createQuickNote(content);
            if (ok) {
                dialog.destroy();
            } else {
                confirmButton.disabled = false;
                confirmButton.textContent = this.i18n.confirm;
            }
        };
        confirmButton.addEventListener("click", submit);
        textarea.addEventListener("keydown", (event) => {
            // 输入法组词中的 Enter 不提交
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
            }
        });
        textarea.focus();
    }

    // 与独立面板窗口之间的 IPC 通信
    initQuickNoteIpc() {
        let electron;
        try {
            electron = window.require("electron");
        } catch (e) {
            return;
        }
        if (!electron || !electron.ipcRenderer) {
            return;
        }
        const ipcRenderer = electron.ipcRenderer;
        this.quickNoteIpcSubmit = (event, data) => {
            if (!data || typeof data.content !== "string") {
                return;
            }
            const winId = data.winId || 0;
            this.createQuickNote(data.content.trim()).then((ok) => {
                this.replyQuickNoteResult(winId, ok);
            });
        };
        this.quickNoteIpcClose = (event, data) => {
            if (data && Array.isArray(data.pos) && data.pos.length === 2 &&
                Number.isFinite(data.pos[0]) && Number.isFinite(data.pos[1])) {
                this.config.quickNotePos = {x: data.pos[0], y: data.pos[1]};
                this.saveConfig();
            }
            this.quickNotePanelWin = null;
        };
        ipcRenderer.on("dnt-quicknote-submit", this.quickNoteIpcSubmit);
        ipcRenderer.on("dnt-quicknote-close", this.quickNoteIpcClose);
    }

    uninitQuickNoteIpc() {
        let electron;
        try {
            electron = window.require("electron");
        } catch (e) {
            return;
        }
        if (!electron || !electron.ipcRenderer) {
            return;
        }
        const ipcRenderer = electron.ipcRenderer;
        if (this.quickNoteIpcSubmit) {
            ipcRenderer.removeListener("dnt-quicknote-submit", this.quickNoteIpcSubmit);
        }
        if (this.quickNoteIpcClose) {
            ipcRenderer.removeListener("dnt-quicknote-close", this.quickNoteIpcClose);
        }
    }

    replyQuickNoteResult(winId, ok) {
        try {
            const remote = window.require("@electron/remote");
            let panel = this.quickNotePanelWin;
            if ((!panel || panel.isDestroyed()) && remote && remote.BrowserWindow && winId) {
                panel = remote.BrowserWindow.getAllWindows().find((item) => item.id === winId);
            }
            if (panel && !panel.isDestroyed()) {
                panel.webContents.send("dnt-quicknote-result", {
                    ok: ok,
                    msg: ok ? "" : this.i18n.quickNoteFailed,
                });
                return;
            }
        } catch (e) {
            console.warn(`[${this.name}] reply quick note result failed:`, e);
        }
        if (ok) {
            showMessage(this.i18n.quickNoteCreated, 5000);
        }
    }

    async createQuickNote(content) {
        const notebook = this.config.quickNoteNotebook;
        if (!notebook) {
            return false;
        }
        if (!content) {
            showMessage(this.i18n.quickNoteEmpty, 4000);
            return false;
        }
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
        // 直接写入笔记本根目录，不创建「速记」文件夹文档
        const path = `/${timestamp}`;
        try {
            const response = await fetchSyncPost("/api/filetree/createDocWithMd", {
                notebook,
                path,
                markdown: content,
            });
            if (response.code === 0) {
                showMessage(this.i18n.quickNoteCreated, 5000);
                // 记事不打开新建的文档，避免打断当前操作
                return true;
            }
        } catch (e) {
            console.warn(`[${this.name}] createQuickNote failed:`, e);
        }
        showMessage(this.i18n.quickNoteFailed, 5000);
        return false;
    }

    /* ---------- 设置 ---------- */

    async showSettingsPanel() {
        const notebooks = await this.getOpenNotebooks();
        const emptyHtml = notebooks.length === 0
            ? `<div class="dnt-panel__empty">${this.i18n.emptyNotebooks}</div>`
            : "";
        const options = [`<option value="">${escapeHtml(this.i18n.notSet)}</option>`];
        notebooks.forEach((item) => {
            const selected = item.id === this.config.quickNoteNotebook ? " selected" : "";
            options.push(`<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(item.name)}</option>`);
        });
        const dialog = new Dialog({
            title: this.i18n.settingsPanelTitle,
            content: `<div class="b3-dialog__content dnt-settings">
    <label class="dnt-settings__label">${this.i18n.quickNoteNotebookLabel}</label>
    <select class="b3-select fn__block dnt-settings__select"${notebooks.length === 0 ? " disabled" : ""}>${options.join("")}</select>
    <div class="dnt-settings__hotkey">${this.i18n.quickNoteHotkeyLabel}：<code>${escapeHtml(this.quickNoteHotkey || this.i18n.notSet)}</code>（${this.i18n.hotkeyHint}）</div>
    ${emptyHtml}
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel">${this.i18n.cancel}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text">${this.i18n.confirm}</button>
</div>`,
            width: this.isMobile ? "92vw" : "480px",
        });
        const cancelButton = dialog.element.querySelector(".b3-button--cancel");
        const confirmButton = dialog.element.querySelector(".b3-button--text");
        const selectElement = dialog.element.querySelector("select");

        cancelButton.addEventListener("click", () => {
            dialog.destroy();
        });
        confirmButton.addEventListener("click", async () => {
            this.config.quickNoteNotebook = selectElement.value;
            await this.saveConfig();
            showMessage(this.i18n.settingsSaved, 5000);
            dialog.destroy();
        });
    }

    async getOpenNotebooks() {
        let notebooks = [];
        try {
            const response = await fetchSyncPost("/api/notebook/lsNotebooks", {});
            notebooks = (response.data && response.data.notebooks) ? response.data.notebooks : [];
        } catch (e) {
            console.warn(`[${this.name}] lsNotebooks failed:`, e);
        }
        return notebooks.filter((item) => !item.closed).sort((a, b) => a.sort - b.sort);
    }

    async saveConfig() {
        try {
            await this.saveData(STORAGE_KEY, this.config);
        } catch (e) {
            console.warn(`[${this.name}] save config failed:`, e);
        }
    }
};
