const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAccount } = require('../lib/account.cjs');

// Exercise account policy and lifecycle with only the unavailable Electron boundary replaced.
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function cookie(value = 'private-session', extra = {}) {
    return { name: 'SESSDATA', value, domain: '.bilibili.com', path: '/', secure: true, httpOnly: true, ...extra };
}
function harness(options = {}) {
    const changes = [], writes = [], windows = [], partitions = [], reads = [];
    let saved = options.saved ?? null;
    const cookies = new EventEmitter();
    cookies.rows = [];
    cookies.get = async () => cookies.rows.map((row) => ({ ...row }));
    cookies.set = async (record) => {
        if (options.cookieSet) await options.cookieSet(record);
        cookies.rows.push({ ...record });
    };
    const isolated = new EventEmitter();
    isolated.cookies = cookies;
    isolated.clearStorageData = async () => {
        if (options.clearStorage) await options.clearStorage();
        cookies.rows = [];
        isolated.clears++;
    };
    isolated.clears = 0;
    isolated.clearCache = async () => { isolated.cacheCleared = true; };
    isolated.setPermissionRequestHandler = (handler) => { isolated.permissionRequest = handler; };
    isolated.setPermissionCheckHandler = (handler) => { isolated.permissionCheck = handler; };
    class BrowserWindow extends EventEmitter {
        constructor(config) {
            super();
            this.config = config;
            const contents = new EventEmitter();
            contents.setWindowOpenHandler = (handler) => { this.popup = handler; };
            contents.stop = () => {
                if (this.destroyed) throw new Error('Object has been destroyed');
                this.stopped = true;
            };
            this.destroyed = false;
            Object.defineProperty(this, 'webContents', { get: () => {
                if (this.destroyed) {
                    this.destroyedGetterReads++;
                    throw new Error('Object has been destroyed');
                }
                return contents;
            } });
            this.destroyedGetterReads = 0;
            windows.push(this);
        }
        loadURL(url) { this.url = url; return options.load ? options.load.promise : Promise.resolve(); }
        isDestroyed() { return this.destroyed; }
        focus() { this.focused = true; }
        close() { this.destroy(); }
        destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    }
    const secrets = {
        get: async (key) => { assert.equal(key, 'bilibili-session'); return options.read ? options.read.promise : saved; },
        set: async (key, value) => {
            assert.equal(key, 'bilibili-session');
            writes.push(value);
            if (options.write) await options.write(value);
            saved = value;
        },
    };
    const account = createAccount({
        electron: { BrowserWindow, session: { fromPartition: (name) => { partitions.push(name); return isolated; } } },
        secrets,
        verifyCookie: async (header, signal) => { reads.push(header); return options.verify ? options.verify(header, signal) : { loggedIn: true, name: 'Alice' }; },
        onChange: (state) => { changes.push(state); if (options.onChange) options.onChange(state); },
    });
    return { account, cookies, isolated, windows, partitions, changes, writes, reads, saved: () => saved };
}

test('synchronous factory restores isolated cookies without claiming a verified login', async (t) => {
    const h = harness({ saved: JSON.stringify([cookie()]) });
    t.after(() => h.account.dispose());
    assert.equal(typeof h.account.snapshot, 'function');
    await h.account.ready;
    assert.equal(h.partitions.length, 1);
    assert.ok(!h.partitions[0].startsWith('persist:'));
    assert.equal(h.account.snapshot().loggedIn, false);
    assert.equal(h.reads.length, 0);
    assert.equal(h.cookies.rows[0].url, 'https://bilibili.com/');
    assert.equal(await h.account.getCookie(), 'SESSDATA=private-session');
    assert.equal(h.windows.length, 0);
    assert.equal(h.cookies.listenerCount('changed'), 0);
});

test('check verifies before persisting a minimal, bounded cookie record', async (t) => {
    const h = harness();
    t.after(() => h.account.dispose());
    await h.account.ready;
    h.cookies.rows = [cookie(), cookie('junk', { name: 'tracking', domain: '.bilibili.com' }), cookie('foreign', { domain: '.evilbilibili.com' })];
    const state = await h.account.check();
    assert.equal(state.loggedIn, true);
    assert.equal(state.name, 'Alice');
    assert.equal(state.status, 'logged-in');
    assert.equal(h.reads[0], 'SESSDATA=private-session');
    assert.equal(h.writes.length, 1);
    assert.equal(JSON.parse(h.saved()).length, 1);
    assert.ok(!h.saved().includes('tracking'));
    assert.ok(!JSON.stringify(h.changes).includes('private-session'));
    assert.deepEqual(Object.keys(state).sort(), ['loggedIn', 'name', 'revision', 'status']);
    const revision = state.revision;
    await h.account.check();
    assert.equal(h.account.snapshot().revision, revision);
});

test('verify false or failure never claims logged in or persists new cookies', async (t) => {
    for (const verify of [async () => ({ loggedIn: false }), async () => { throw new Error('secret upstream'); }]) {
        const h = harness({ verify });
        t.after(() => h.account.dispose());
        await h.account.ready;
        h.cookies.rows = [cookie()];
        try { await h.account.check(); } catch (error) { assert.ok(!error.message.includes('secret upstream')); }
        assert.equal(h.account.snapshot().loggedIn, false);
        assert.equal(h.account.snapshot().name, '');
        assert.equal(h.writes.length, 0);
    }
});

test('login window is single-instance, hardened, and open resolves after page load only', async (t) => {
    const h = harness();
    t.after(() => h.account.dispose());
    await h.account.ready;
    await Promise.all([h.account.open(), h.account.open()]);
    assert.equal(h.windows.length, 1);
    const win = h.windows[0];
    assert.equal(win.url, 'https://passport.bilibili.com/login');
    assert.deepEqual(win.config.webPreferences, {
        session: h.isolated, sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false,
    });
    assert.deepEqual(win.popup({ url: 'https://www.bilibili.com/' }), { action: 'deny' });
    assert.equal(h.isolated.permissionCheck(), false);
    let permitted;
    h.isolated.permissionRequest(null, 'camera', (answer) => { permitted = answer; });
    assert.equal(permitted, false);
    let cancelled = false;
    h.isolated.emit('will-download', { preventDefault: () => { cancelled = true; } });
    assert.equal(cancelled, true);
    for (const url of ['file:///C:/x', 'javascript:alert(1)', 'http://www.bilibili.com/', 'https://www.bilibili.com:444/', 'https://u:p@www.bilibili.com/', 'https://evil.com/', 'https://www.bilibili.com.evil.com/', 'https://cdn.bilibili.com/']) {
        for (const eventName of ['will-navigate', 'will-redirect']) {
            let blocked = false;
            win.webContents.emit(eventName, { preventDefault: () => { blocked = true; } }, url, false, true);
            assert.equal(blocked, true, `${eventName}: ${url}`);
        }
    }
    for (const url of ['https://passport.bilibili.com/login', 'https://www.bilibili.com/', 'https://account.bilibili.com/']) {
        let blocked = false;
        win.webContents.emit('will-navigate', { preventDefault: () => { blocked = true; } }, url);
        assert.equal(blocked, false, url);
    }
    assert.equal(h.reads.length, 0);
    assert.equal(h.cookies.listenerCount('changed'), 1);
});

test('closing login window checks once and removes cookie listener', async (t) => {
    const h = harness();
    t.after(() => h.account.dispose());
    await h.account.open();
    h.cookies.rows = [cookie()];
    assert.doesNotThrow(() => h.windows[0].close());
    await h.account.check();
    await tick();
    assert.equal(h.windows[0].destroyedGetterReads, 0);
    assert.equal(h.account.snapshot().loggedIn, true);
    assert.equal(h.reads.length, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.cookies.listenerCount('changed'), 0);
});

test('verified login closes only after credentials are saved and logged-in is published', async (t) => {
    const writing = deferred();
    const h = harness({ write: () => writing.promise });
    t.after(() => h.account.dispose());
    await h.account.open();
    const win = h.windows[0];
    let closedState, closedSecret;
    win.once('closed', () => { closedState = h.account.snapshot(); closedSecret = h.saved(); });
    h.cookies.rows = [cookie()];
    const checking = h.account.check();
    while (!h.writes.length) await tick();
    assert.equal(win.destroyed, false);
    assert.equal(h.account.snapshot().loggedIn, false);
    writing.resolve();
    const state = await checking;
    await tick();
    assert.equal(win.destroyed, true);
    assert.equal(win.destroyedGetterReads, 0);
    assert.equal(closedState.loggedIn, true);
    assert.equal(closedSecret, h.saved());
    assert.ok(closedSecret);
    assert.equal(state.status, 'logged-in');
    assert.equal(h.account.snapshot().revision, state.revision);
    assert.equal(h.cookies.listenerCount('changed'), 0);
    assert.equal(h.reads.length, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(h.isolated.clears, 0);
    assert.equal(await h.account.getCookie(), 'SESSDATA=private-session');
});

test('unverified login, verification errors and failed storage leave the window open', async (t) => {
    for (const options of [
        { verify: async () => ({ loggedIn: false }) },
        { verify: async () => { throw new Error('upstream'); } },
        { write: async () => { throw new Error('storage'); } },
    ]) {
        const h = harness(options);
        t.after(() => h.account.dispose());
        await h.account.open();
        h.cookies.rows = [cookie()];
        try { await h.account.check(); } catch (error) { assert.match(error.message, /^bili:/); }
        assert.equal(h.windows[0].destroyed, false);
        assert.equal(h.account.snapshot().loggedIn, false);
        assert.equal(h.saved(), null);
        assert.equal(h.cookies.listenerCount('changed'), 1);
    }
});

test('logout and dispose close a native window without reading destroyed getters or checking again', async () => {
    for (const operation of ['logout', 'dispose']) {
        const h = harness();
        await h.account.open();
        h.cookies.rows = [cookie()];
        let closed = 0;
        h.windows[0].once('closed', () => closed++);
        await h.account[operation]();
        await tick();
        assert.equal(closed, 1);
        assert.equal(h.windows[0].destroyed, true);
        assert.equal(h.windows[0].destroyedGetterReads, 0);
        assert.equal(h.reads.length, 0);
        assert.equal(h.cookies.listenerCount('changed'), 0);
        assert.equal(h.account.snapshot().status, operation === 'logout' ? 'logged-out' : 'disposed');
        h.account.dispose();
    }
});

test('closing during verification shares its check and a late load rejection cannot replace login success', async (t) => {
    for (const manual of [false, true]) {
        const load = deferred(), verification = deferred();
        const h = harness({ load, verify: () => verification.promise });
        t.after(() => h.account.dispose());
        const opening = h.account.open();
        while (!h.windows.length) await tick();
        h.cookies.rows = [cookie()];
        const checking = h.account.check();
        while (!h.reads.length) await tick();
        if (manual) assert.doesNotThrow(() => h.windows[0].close());
        verification.resolve({ loggedIn: true, name: 'Alice' });
        await checking;
        assert.equal(h.windows[0].destroyed, true);
        load.reject(new Error('load aborted by close'));
        await opening;
        await tick();
        assert.equal(h.account.snapshot().status, 'logged-in');
        assert.equal(h.windows[0].destroyedGetterReads, 0);
        assert.equal(h.reads.length, 1);
        assert.equal(h.writes.length, 1);
        assert.ok(!h.changes.some((state) => state.status === 'error'));
    }
});

test('manual close while load and verification are pending does not report a window error', async (t) => {
    const load = deferred(), verification = deferred();
    const h = harness({ load, verify: () => verification.promise });
    t.after(() => h.account.dispose());
    const opening = h.account.open();
    while (!h.windows.length) await tick();
    h.cookies.rows = [cookie()];
    const checking = h.account.check();
    while (!h.reads.length) await tick();
    assert.doesNotThrow(() => h.windows[0].close());
    load.reject(new Error('closed while checking'));
    await opening;
    assert.equal(h.account.snapshot().status, 'checking');
    verification.resolve({ loggedIn: true });
    await checking;
    assert.equal(h.account.snapshot().status, 'logged-in');
    assert.equal(h.reads.length, 1);
    assert.ok(!h.changes.some((state) => state.status === 'error'));
});

test('verification for a manually closed window does not close a replacement window', async (t) => {
    const verification = deferred();
    const h = harness({ verify: () => verification.promise });
    t.after(() => h.account.dispose());
    await h.account.open();
    h.cookies.rows = [cookie()];
    const checking = h.account.check();
    while (!h.reads.length) await tick();
    assert.doesNotThrow(() => h.windows[0].close());
    await h.account.open();
    verification.resolve({ loggedIn: true });
    await checking;
    assert.equal(h.windows[1].destroyed, false);
    assert.equal(h.account.snapshot().status, 'logged-in');
});

test('malformed and overlong saved secrets fail closed with redacted storage error', async () => {
    for (const saved of ['private-session'.repeat(1000), '{private-session', JSON.stringify({ cookie: 'private-session' }), JSON.stringify([cookie('x\r\nInjected: private-session')]), JSON.stringify([cookie('x', { domain: '.bilibili.com.evil.com' })])]) {
        const h = harness({ saved });
        await assert.rejects(h.account.ready, (error) => error.message === 'bili:credential-storage');
        assert.equal(h.account.snapshot().loggedIn, false);
        assert.equal(h.account.snapshot().status, 'error');
        assert.equal(h.cookies.rows.length, 0);
        assert.ok(!JSON.stringify(h.changes).includes('private-session'));
        await assert.rejects(h.account.getCookie(), /bili:credential-storage/);
        h.account.dispose();
    }
});

test('expired records are dropped and cookie header excludes unsafe values', async (t) => {
    const h = harness({ saved: JSON.stringify([cookie('expired', { expirationDate: 1 })]) });
    t.after(() => h.account.dispose());
    await h.account.ready;
    assert.equal(await h.account.getCookie(), '');
    h.cookies.rows = [cookie(), cookie('bad;value', { name: 'sid' }), cookie('line\nfeed', { name: 'bili_jct' })];
    await assert.rejects(h.account.getCookie(), /bili:credential-storage/);
});

test('logout clears all isolated data, secret and window and advances credential revision', async (t) => {
    const h = harness();
    t.after(() => h.account.dispose());
    await h.account.open();
    h.cookies.rows = [cookie()];
    await h.account.check();
    const before = h.account.snapshot().revision;
    const state = await h.account.logout();
    assert.equal(state.loggedIn, false);
    assert.equal(state.name, '');
    assert.ok(state.revision > before);
    assert.equal(h.saved(), null);
    assert.equal(h.isolated.clears, 1);
    assert.equal(h.isolated.cacheCleared, true);
    assert.equal(h.windows[0].destroyed, true);
    assert.equal(h.cookies.listenerCount('changed'), 0);
    assert.equal(await h.account.getCookie(), '');
});

test('pending verification cannot restore a logged-out account', async (t) => {
    const verify = deferred();
    const h = harness({ verify: () => verify.promise });
    t.after(() => h.account.dispose());
    await h.account.ready;
    h.cookies.rows = [cookie()];
    const checking = h.account.check();
    while (h.reads.length === 0) await tick();
    await h.account.logout();
    verify.resolve({ loggedIn: true, name: 'late' });
    await checking;
    assert.equal(h.saved(), null);
    assert.equal(h.account.snapshot().loggedIn, false);
    assert.equal(h.account.snapshot().name, '');
});

test('logout serializes after an already running secure write', async (t) => {
    const writing = deferred();
    const h = harness({ write: (value) => value === null ? undefined : writing.promise });
    t.after(() => h.account.dispose());
    await h.account.ready;
    h.cookies.rows = [cookie()];
    const checking = h.account.check();
    while (h.writes.length === 0) await tick();
    const logout = h.account.logout();
    assert.equal(h.account.snapshot().loggedIn, false);
    writing.resolve();
    await Promise.all([checking, logout]);
    assert.equal(h.saved(), null);
    assert.equal(h.writes.at(-1), null);
    assert.equal(h.cookies.rows.length, 0);
});

test('dispose rolls a pending secure write back to the last committed credential', async () => {
    for (const initial of [null, JSON.stringify([cookie('previous')])]) {
        const writing = deferred();
        const h = harness({ saved: initial, write: (value) => value?.includes('pending-secret') ? writing.promise : undefined });
        await h.account.ready;
        h.cookies.rows = [cookie('pending-secret')];
        const checking = h.account.check();
        while (h.writes.length === 0) await tick();
        h.account.dispose();
        writing.resolve();
        await checking;
        await tick();
        assert.equal(h.saved(), initial);
        assert.equal(h.writes.at(-1), initial);
        assert.equal(h.account.snapshot().status, 'disposed');
    }
});

test('dispose rollback preserves a previously completed check and never overrides queued logout', async () => {
    for (const logoutFirst of [false, true]) {
        const writing = deferred();
        const h = harness({ write: (value) => value?.includes('pending-secret') ? writing.promise : undefined });
        await h.account.ready;
        h.cookies.rows = [cookie('committed')];
        await h.account.check();
        const committed = h.saved();
        h.cookies.rows = [cookie('pending-secret')];
        const checking = h.account.check();
        while (h.writes.length < 2) await tick();
        const logout = logoutFirst ? h.account.logout() : Promise.resolve();
        h.account.dispose();
        writing.resolve();
        await Promise.all([checking, logout]);
        await tick();
        assert.equal(h.saved(), logoutFirst ? null : committed);
        assert.equal(h.writes.at(-1), logoutFirst ? null : committed);
    }
});

test('a host rejecting rollback after dispose does not cause an unhandled rejection', async () => {
    const writing = deferred();
    const h = harness({ write: (value) => {
        if (value === null) throw new Error('host stopped private-session');
        return writing.promise;
    } });
    await h.account.ready;
    h.cookies.rows = [cookie('pending-secret')];
    const checking = h.account.check();
    while (!h.writes.length) await tick();
    h.account.dispose();
    writing.resolve();
    await checking;
    await tick();
    assert.equal(h.writes.at(-1), null);
    assert.equal(h.account.snapshot().status, 'disposed');
});

test('logout invalidates pending restore before it can set cookies', async (t) => {
    const read = deferred();
    const h = harness({ read });
    t.after(() => h.account.dispose());
    const logout = h.account.logout();
    read.resolve(JSON.stringify([cookie()]));
    await Promise.all([h.account.ready, logout]);
    assert.equal(h.cookies.rows.length, 0);
    assert.equal(h.saved(), null);
    assert.equal(h.account.snapshot().loggedIn, false);
});

test('logout and dispose interrupt pending window load without a late reopen', async () => {
    for (const operation of ['logout', 'dispose']) {
        const load = deferred();
        const h = harness({ load });
        await h.account.ready;
        const opening = h.account.open();
        while (h.windows.length === 0) await tick();
        await h.account[operation]();
        await opening;
        load.reject(new Error('private-session load rejected after cancel'));
        await tick();
        assert.equal(h.windows[0].destroyed, true);
        assert.equal(h.cookies.listenerCount('changed'), 0);
        assert.equal(h.account.snapshot().loggedIn, false);
        h.account.dispose();
    }
});

test('dispose synchronously cancels listeners/window and preserves saved credentials', async () => {
    const h = harness({ saved: JSON.stringify([cookie()]) });
    await h.account.open();
    const before = h.saved();
    h.account.dispose();
    assert.equal(h.windows[0].destroyed, true);
    assert.equal(h.cookies.listenerCount('changed'), 0);
    assert.equal(h.account.snapshot().status, 'disposed');
    assert.equal(h.account.snapshot().loggedIn, false);
    assert.equal(h.saved(), before);
    assert.equal(await h.account.getCookie(), '');
    await tick();
    assert.equal(h.cookies.rows.length, 0);
    assert.equal(h.saved(), before);
});

test('dispose aborts the injected nav request, not just its eventual state update', async () => {
    let signal;
    const verifying = deferred();
    const h = harness({ verify: (_header, nextSignal) => { signal = nextSignal; return verifying.promise; } });
    await h.account.ready;
    h.cookies.rows = [cookie()];
    const check = h.account.check();
    while (!h.reads.length) await tick();
    assert.ok(signal instanceof AbortSignal);
    h.account.dispose();
    assert.equal(signal.aborted, true);
    await check;
    verifying.reject(new Error('late private-session'));
    await tick();
    assert.equal(h.writes.length, 0);
});

test('an explicit logout recovers from a bad saved secret for a new login', async (t) => {
    const h = harness({ saved: 'malformed' });
    t.after(() => h.account.dispose());
    await assert.rejects(h.account.ready, /bili:credential-storage/);
    await h.account.logout();
    assert.equal(await h.account.getCookie(), '');
    await h.account.open();
    assert.equal(h.windows.length, 1);
});

test('clearing an in-memory partition also closes connections and authentication cache', async (t) => {
    const h = harness();
    t.after(() => h.account.dispose());
    let connectionsClosed = false, authCleared = false;
    h.isolated.closeAllConnections = async () => { connectionsClosed = true; };
    h.isolated.clearAuthCache = async () => { authCleared = true; };
    await h.account.logout();
    assert.equal(connectionsClosed, true);
    assert.equal(authCleared, true);
});

test('a changed credential invalidates verification and cannot persist the old header', async (t) => {
    const verification = deferred();
    const h = harness({ verify: () => verification.promise });
    t.after(() => h.account.dispose());
    await h.account.ready;
    h.cookies.rows = [cookie('one')];
    const checking = h.account.check();
    while (!h.reads.length) await tick();
    h.cookies.rows = [cookie('two')];
    verification.resolve({ loggedIn: true, name: 'old' });
    const state = await checking;
    assert.equal(state.loggedIn, false);
    assert.equal(state.revision, 2);
    assert.equal(h.writes.length, 0);
});

test('dispose during native cookie restore queues cleanup after the pending native mutation', async () => {
    const setting = deferred();
    const h = harness({ saved: JSON.stringify([cookie()]), cookieSet: () => setting.promise });
    await tick();
    h.account.dispose();
    setting.resolve();
    await h.account.ready;
    await tick();
    assert.equal(h.cookies.rows.length, 0);
    assert.equal(h.account.snapshot().status, 'disposed');
    assert.equal(h.saved(), JSON.stringify([cookie()]));
});

test('secret read and write exceptions are redacted and readiness is safely handled', async (t) => {
    const read = deferred();
    const failedRead = harness({ read });
    read.reject(new Error('private-session read failed'));
    await tick();
    await assert.rejects(failedRead.account.ready, { message: 'bili:credential-storage' });
    failedRead.account.dispose();
    const h = harness({ write: async () => { throw new Error('private-session write failed'); } });
    t.after(() => h.account.dispose());
    await h.account.ready;
    h.cookies.rows = [cookie()];
    await assert.rejects(h.account.check(), { message: 'bili:credential-storage' });
    assert.equal(h.account.snapshot().loggedIn, false);
});

test('cookie validation rejects invalid bounds and encoded separators before verification', async () => {
    for (const record of [cookie('x'.repeat(4097)), cookie('space value'), cookie('x', { expirationDate: 'tomorrow' }), cookie('x', { path: '/other' }), cookie('x', { domain: '.bilibili.com\n' }), cookie('x', { name: 'other' }), cookie('x', { secure: 'true' })]) {
        const h = harness({ saved: JSON.stringify([record]) });
        await assert.rejects(h.account.ready, { message: 'bili:credential-storage' });
        assert.equal(h.reads.length, 0);
        h.account.dispose();
    }
    const huge = harness({ saved: JSON.stringify([cookie('x'.repeat(4000)), cookie('y'.repeat(4000), { name: 'sid' }), cookie('z'.repeat(1000), { name: 'buvid3' })]) });
    await assert.rejects(huge.account.ready, { message: 'bili:credential-storage' });
    huge.account.dispose();
});
