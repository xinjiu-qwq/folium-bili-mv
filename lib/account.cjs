const { randomUUID } = require('node:crypto');

// Own a memory-only official login window and keep verified credentials inside the main process.
const SECRET_KEY = 'bilibili-session';
const MAX_BYTES = 8192;
const COOKIE_NAMES = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_nut']);
const LOGIN_HOSTS = new Set(['passport.bilibili.com', 'www.bilibili.com', 'account.bilibili.com']);
const CANCELLED = Symbol('cancelled');
const storageError = () => new Error('bili:credential-storage');

function allowedNavigation(input) {
    try {
        const url = new URL(input);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && LOGIN_HOSTS.has(url.hostname);
    } catch { return false; }
}

// Validate before either restoring or constructing an API Cookie header; never retain arbitrary page cookies.
function recordsFrom(input, strict) {
    if (!Array.isArray(input) || input.length > 64) throw storageError();
    const records = [];
    const seen = new Set();
    for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw storageError();
        const domain = typeof item.domain === 'string' ? item.domain.replace(/^\./, '').toLowerCase() : '';
        const official = domain.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*bilibili\.com$/.test(domain);
        if (!COOKIE_NAMES.has(item.name) || !official) {
            if (strict) throw storageError();
            continue;
        }
        if (typeof item.value !== 'string' || item.value.length === 0 || item.value.length > 4096 || !/^[\x21-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(item.value)) throw storageError();
        if (item.path !== undefined && item.path !== '/') throw storageError();
        if (item.secure !== undefined && typeof item.secure !== 'boolean') throw storageError();
        if (item.httpOnly !== undefined && typeof item.httpOnly !== 'boolean') throw storageError();
        if (item.expirationDate !== undefined && (!Number.isFinite(item.expirationDate) || item.expirationDate < 0 || item.expirationDate > 253402300799)) throw storageError();
        if (item.expirationDate !== undefined && item.expirationDate <= Date.now() / 1000) continue;
        if (seen.has(item.name)) throw storageError();
        seen.add(item.name);
        const record = { name: item.name, value: item.value, domain: item.domain.startsWith('.') ? `.${domain}` : domain, path: '/', secure: true, httpOnly: item.httpOnly === true };
        if (item.expirationDate !== undefined) record.expirationDate = item.expirationDate;
        records.push(record);
    }
    records.sort((a, b) => a.name.localeCompare(b.name));
    if (Buffer.byteLength(JSON.stringify(records), 'utf8') > MAX_BYTES) throw storageError();
    return records;
}

function createAccount({ electron, secrets, verifyCookie, onChange = () => {} }) {
    const isolated = electron.session.fromPartition(`bili-mv-login-${randomUUID()}`, { cache: false });
    let disposed = false;
    let disposeSignal = null;
    let committedSecret = null;
    let controller = new AbortController();
    let mutation = Promise.resolve();
    let window = null;
    let opening = null;
    let checking = null;
    let timer = null;
    let fingerprint = '';
    let state = { loggedIn: false, name: '', status: 'idle', revision: 0 };

    const snapshot = () => ({ ...state });
    const active = (signal) => !disposed && !signal.aborted;
    function notify(patch) {
        state = { ...state, ...patch };
        try { onChange(snapshot()); } catch { /* A consumer must not break credential cleanup. */ }
    }
    function observe(records) {
        const next = records.map(({ name, value }) => `${name}=${value}`).join('; ');
        if (fingerprint !== next) {
            fingerprint = next;
            notify({ loggedIn: false, name: '', revision: state.revision + 1 });
        }
        return next;
    }
    function enqueue(run) {
        const result = mutation.then(run);
        mutation = result.catch(() => {});
        return result;
    }
    // Race only reads/network/load against lifecycle abort. Mutations must finish before queued cleanup.
    function cancellable(promise, signal) {
        if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.resolve(CANCELLED); }
        return new Promise((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); resolve(CANCELLED); };
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve(promise).then((value) => {
                signal.removeEventListener('abort', abort);
                resolve(value);
            }, (error) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            });
        });
    }
    function stopWatching() {
        if (timer) clearTimeout(timer);
        timer = null;
        isolated.cookies.removeListener('changed', cookieChanged);
    }
    function cookieChanged() {
        if (!window || disposed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            if (window && !disposed) check().catch(() => {});
        }, 300);
        timer.unref?.();
    }
    function closeWindow() {
        stopWatching();
        const previous = window;
        window = null;
        if (previous && !previous.isDestroyed()) {
            try { previous.webContents.stop(); } catch { /* Window may already be closing. */ }
            try { previous.destroy(); } catch { /* Continue cleanup even when native teardown fails. */ }
        }
    }
    function invalidate() {
        controller.abort();
        controller = new AbortController();
        checking = null;
        opening = null;
        closeWindow();
        observe([]);
    }
    const denyDownload = (event) => event.preventDefault();
    isolated.on('will-download', denyDownload);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);

    const restoreSignal = controller.signal;
    const ready = (async () => {
        try {
            const saved = await cancellable(secrets.get(SECRET_KEY), restoreSignal);
            if (!active(restoreSignal) || saved === CANCELLED || saved === null || saved === undefined) return;
            if (typeof saved !== 'string' || Buffer.byteLength(saved, 'utf8') > MAX_BYTES) throw storageError();
            const records = recordsFrom(JSON.parse(saved), true);
            committedSecret = saved;
            await enqueue(async () => {
                if (!active(restoreSignal)) return;
                for (const record of records) {
                    if (!active(restoreSignal)) break;
                    const domain = record.domain.replace(/^\./, '');
                    await isolated.cookies.set({ ...record, url: `https://${domain}/` });
                }
                if (active(restoreSignal)) observe(records);
            });
        } catch {
            if (active(restoreSignal)) {
                notify({ loggedIn: false, name: '', status: 'error' });
                throw storageError();
            }
        }
    })();
    // Activation may be cancelled before anyone awaits ready; preserve rejection for callers without a global rejection.
    ready.catch(() => {});
    async function awaitRestore() {
        try { await ready; }
        catch (error) { if (!restoreSignal.aborted) throw error; }
    }

    async function readRecords(signal) {
        const rows = await cancellable(isolated.cookies.get({}), signal);
        if (rows === CANCELLED || !active(signal)) return CANCELLED;
        return recordsFrom(rows, false);
    }
    async function getCookie() {
        if (disposed) return '';
        const signal = controller.signal;
        try {
            await awaitRestore();
            await mutation;
            if (!active(signal)) return '';
            const records = await readRecords(signal);
            if (records === CANCELLED || !active(signal)) return '';
            return observe(records);
        } catch {
            if (!active(signal)) return '';
            notify({ loggedIn: false, name: '', status: 'error' });
            throw storageError();
        }
    }

    function check() {
        if (disposed) return Promise.resolve(snapshot());
        if (checking) return checking;
        const signal = controller.signal;
        const login = window;
        const pending = (async () => {
            try {
                await awaitRestore();
                await mutation;
                if (!active(signal)) return snapshot();
                notify({ loggedIn: false, name: '', status: 'checking' });
                const records = await readRecords(signal);
                if (records === CANCELLED || !active(signal)) return snapshot();
                const header = observe(records);
                if (!header) { notify({ loggedIn: false, name: '', status: 'logged-out' }); return snapshot(); }
                let verified;
                try { verified = await cancellable(verifyCookie(header, signal), signal); }
                catch { throw new Error('bili:account-check'); }
                if (verified === CANCELLED || !active(signal)) return snapshot();
                if (verified?.loggedIn !== true) {
                    notify({ loggedIn: false, name: '', status: 'logged-out' });
                    return snapshot();
                }
                await enqueue(async () => {
                    if (!active(signal)) return;
                    // Do not persist a credential set that changed while the nav request was in flight.
                    const current = await readRecords(signal);
                    if (current === CANCELLED || !active(signal)) return;
                    if (JSON.stringify(current) !== JSON.stringify(records)) {
                        observe(current);
                        notify({ loggedIn: false, name: '', status: 'idle' });
                        return;
                    }
                    const nextSecret = JSON.stringify(records);
                    try { await secrets.set(SECRET_KEY, nextSecret); }
                    catch { throw storageError(); }
                    if (!active(signal)) {
                        // Only undo a write cancelled by dispose itself. A preceding logout owns its queued null write.
                        if (disposed && signal === disposeSignal) {
                            try { await secrets.set(SECRET_KEY, committedSecret); }
                            catch { /* Host shutdown may revoke secret access; rollback is best effort. */ }
                        }
                        return;
                    }
                    committedSecret = nextSecret;
                    const name = typeof verified.name === 'string' ? verified.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128) : '';
                    notify({ loggedIn: true, name, status: 'logged-in' });
                    if (active(signal) && login && window === login) closeWindow();
                });
                return snapshot();
            } catch (error) {
                if (!active(signal)) return snapshot();
                notify({ loggedIn: false, name: '', status: 'error' });
                throw new Error(error?.message === 'bili:account-check' ? 'bili:account-check' : 'bili:credential-storage');
            }
        })();
        checking = pending;
        pending.finally(() => { if (checking === pending) checking = null; }).catch(() => {});
        return pending;
    }

    function open() {
        if (disposed) return Promise.resolve(snapshot());
        if (opening) return opening;
        const signal = controller.signal;
        const pending = (async () => {
            await awaitRestore();
            await mutation;
            if (!active(signal)) return snapshot();
            if (window && !window.isDestroyed()) { window.focus(); return snapshot(); }
            const login = new electron.BrowserWindow({
                width: 1000, height: 760,
                webPreferences: { session: isolated, sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false },
            });
            window = login;
            const contents = login.webContents;
            contents.setWindowOpenHandler(() => ({ action: 'deny' }));
            const navigate = (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); };
            contents.on('will-navigate', navigate);
            contents.on('will-redirect', navigate);
            contents.on('will-attach-webview', (event) => event.preventDefault());
            isolated.cookies.on('changed', cookieChanged);
            login.once('closed', () => {
                // Native window/contents are already destroyed; their listeners die with them.
                if (window !== login) return;
                window = null;
                stopWatching();
                if (active(signal)) check().catch(() => {});
            });
            try { await cancellable(login.loadURL('https://passport.bilibili.com/login'), signal); }
            catch {
                if (active(signal) && window === login) {
                    closeWindow();
                    notify({ status: 'error' });
                    throw new Error('bili:account-window');
                }
            }
            return snapshot();
        })();
        opening = pending;
        pending.finally(() => { if (opening === pending) opening = null; }).catch(() => {});
        return pending;
    }

    async function clearSession() {
        let failed = false;
        try { await isolated.clearStorageData(); } catch { failed = true; }
        try { await isolated.clearCache(); } catch { failed = true; }
        try { await isolated.clearAuthCache?.(); } catch { failed = true; }
        try { await isolated.closeAllConnections?.(); } catch { failed = true; }
        if (failed) throw storageError();
    }
    function logout() {
        if (disposed) return Promise.resolve(snapshot());
        invalidate();
        const signal = controller.signal;
        notify({ loggedIn: false, name: '', status: 'logged-out' });
        return enqueue(async () => {
            let failed = false;
            try { await clearSession(); } catch { failed = true; }
            try { await secrets.set(SECRET_KEY, null); committedSecret = null; } catch { failed = true; }
            if (failed) {
                if (active(signal)) notify({ status: 'error' });
                throw storageError();
            }
            return snapshot();
        });
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        disposeSignal = controller.signal;
        invalidate();
        notify({ loggedIn: false, name: '', status: 'disposed' });
        isolated.removeListener('will-download', denyDownload);
        enqueue(clearSession).catch(() => {});
    }
    return { ready, getCookie, snapshot, open, check, logout, dispose };
}

module.exports = { createAccount };
