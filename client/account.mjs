import { errorText } from './errors.mjs';

// One lazy controller per activation shares only validated account snapshots, never credentials.
const statuses = new Set(['idle', 'checking', 'logged-in', 'logged-out', 'error', 'disposed']);
const descriptions = {
    idle: '尚未检查登录，请打开官方登录窗口或检查登录。',
    checking: '正在检查登录…',
    'logged-in': '登录已验证。',
    'logged-out': '未登录。请在官方窗口完成登录，然后检查登录。',
    error: '登录检查失败，请重新检查登录。',
    disposed: '账号服务已停止。',
};
function safeState(raw) {
    if (!raw || typeof raw.loggedIn !== 'boolean' || typeof raw.name !== 'string' || !statuses.has(raw.status) || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return null;
    const loggedIn = raw.loggedIn && raw.status === 'logged-in';
    return { loggedIn, name: loggedIn ? raw.name.slice(0, 120) : '', status: raw.status, revision: raw.revision };
}
export function createAccount(folium) {
    let data = { state: { loggedIn: false, name: '', status: 'idle', revision: 0 }, busy: false, message: '' };
    let users = 0; let ended = false; let generation = 0; let unlisten = null;
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn());
    const accept = raw => {
        const state = safeState(raw);
        if (!state || state.revision < data.state.revision) return false;
        data = { ...data, state, message: '' }; emit(); return true;
    };
    async function request(name, gen) {
        try {
            const raw = await folium.rpc.call(`account.${name}`);
            if (ended || gen !== generation || !users) return;
            if (!safeState(raw)) throw Error('bili:invalid-response');
            accept(raw);
        } catch (error) {
            if (!ended && gen === generation && users) { data = { ...data, message: errorText(error, '账号操作') }; emit(); }
        }
    }
    function acquire() {
        if (ended || folium.env.context !== 'main') return () => {};
        if (++users === 1) {
            const gen = ++generation;
            unlisten = folium.rpc.on('account.changed', raw => { if (!ended && gen === generation) accept(raw); });
            void request('status', gen);
        }
        let released = false;
        return () => { if (released) return; released = true; if (--users === 0) { generation++; unlisten?.(); unlisten = null; data = { ...data, busy: false }; } };
    }
    return {
        get: () => data, acquire,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        async action(name) {
            if (ended || !users || data.busy || folium.env.context !== 'main' || !['open', 'check', 'logout'].includes(name)) return;
            const gen = generation; data = { ...data, busy: true, message: '' }; emit();
            await request(name, gen);
            if (!ended && gen === generation) { data = { ...data, busy: false }; emit(); }
        },
        dispose() { if (ended) return; ended = true; generation++; unlisten?.(); unlisten = null; listeners.clear(); },
    };
}

export function mountAccount(account, container, ctx) {
    const doc = container.ownerDocument; const root = doc.createElement('div'); const style = doc.createElement('style');
    root.className = 'mv-account';
    style.textContent = '.mv-account{font:inherit;font-size:13px;line-height:1.5;color:var(--mv-account-primary);padding:8px 0}.mv-account p{margin:0 0 6px;overflow-wrap:anywhere}.mv-account-actions{display:flex;gap:6px;flex-wrap:wrap}.mv-account button{font:inherit;color:inherit;background:transparent;border:1px solid var(--mv-account-secondary);border-radius:5px;padding:5px 8px;cursor:pointer}.mv-account button:disabled{opacity:.45;cursor:default}.mv-account button:focus-visible{outline:2px solid #00a1d6;outline-offset:2px}.mv-account-note{color:var(--mv-account-secondary)}';
    const title = doc.createElement('p'); const status = doc.createElement('p'); status.className = 'mv-account-note'; status.setAttribute('role', 'status');
    const actions = doc.createElement('div'); actions.className = 'mv-account-actions'; const cleanups = []; const buttons = [];
    for (const [name, label] of [['open', '打开官方登录窗'], ['check', '检查登录'], ['logout', '退出登录']]) {
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
        const click = () => { void account.action(name); }; button.addEventListener('click', click); cleanups.push(() => button.removeEventListener('click', click)); buttons.push(button); actions.append(button);
    }
    const hint = doc.createElement('p'); hint.className = 'mv-account-note'; hint.textContent = '登录仅在 B站官方窗口完成；账号变化后请点击“重试播放”。';
    root.append(style, title, status, actions, hint); container.append(root);
    const paint = () => { const data = account.get(); title.textContent = data.state.loggedIn ? `B站账号：${data.state.name || '已登录'}` : 'B站账号：未登录'; status.textContent = data.message || descriptions[data.state.status]; buttons.forEach(button => { button.disabled = data.busy || data.state.status === 'disposed'; }); };
    const theme = () => { const t = ctx.getTheme(); root.style.setProperty?.('--mv-account-primary', t.primaryColor); root.style.setProperty?.('--mv-account-secondary', t.secondaryColor); };
    const release = account.acquire(); const unsub = account.subscribe(paint); const untheme = ctx.onChange(theme); theme(); paint(); let ended = false;
    return () => { if (ended) return; ended = true; unsub(); untheme(); release(); cleanups.forEach(fn => fn()); root.remove(); };
}
