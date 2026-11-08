const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// Replace only module dependencies at load time; exercise the actual exported activation function.
const BV = 'BV17x411w7KC';
const UPSTREAM = 'https://upos-sz-mirrorcos.bilivideo.com/video.mp4';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function fixture({ client: overrides = {}, server: serverOverrides = {}, account: accountOverrides = {}, start, initialChange, ready } = {}) {
    const state = { clientClosed: 0, serverClosed: 0, accountDisposed: 0, issued: [], revoked: [], detailsCalls: [], resolved: [], started: 0, clients: [], events: [] };
    let snapshot = { loggedIn: false, name: '', status: 'idle', revision: 0 };
    const electron = {};
    const secrets = {};
    let accountOptions;
    const account = {
        ready: ready?.promise || Promise.resolve(),
        async getCookie() { return 'SESSDATA=secret'; },
        snapshot() { return snapshot; },
        async open() { return snapshot; },
        async check() { return snapshot; },
        async logout() { return snapshot; },
        dispose() { state.accountDisposed++; },
        ...accountOverrides,
    };
    function change(next) { snapshot = next; accountOptions.onChange(next); }
    const server = {
        issue(url, ttl) { state.issued.push({ url, ttl }); return `http://127.0.0.1:3000/media/token-${state.issued.length}`; },
        revoke(url) { state.revoked.push(url); },
        async close() { state.serverClosed++; },
        ...serverOverrides,
    };
    const client = {
        async search(keyword) { return [{ title: keyword }]; },
        async details(bvid) { state.detailsCalls.push(bvid); return { bvid, title: 'MV', pages: [{ cid: 123, page: 1, title: 'P1', duration: 42 }] }; },
        async resolve(input) { state.resolved.push(input); return { url: UPSTREAM, duration: 42 }; },
        close() { state.clientClosed++; },
        ...overrides,
    };
    const originalLoad = Module._load;
    let activate;
    try {
        Module._load = function (request, parent, isMain) {
            if (parent?.filename === path.resolve(__dirname, '../main.cjs')) {
                if (request === 'electron') return electron;
                if (request === './lib/account.cjs') return { createAccount: (options) => {
                    accountOptions = options;
                    assert.equal(options.electron, electron);
                    assert.equal(options.secrets, secrets);
                    if (initialChange) change(initialChange);
                    return account;
                } };
                if (request === './lib/bilibili.cjs') return { createBilibiliClient: (options) => {
                    const instance = { ...client, options };
                    state.clients.push(instance);
                    return instance;
                } };
                if (request === './lib/media-server.cjs') return { createMediaServer: () => { state.started++; return start ? start.promise : Promise.resolve(server); } };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        const main = require.resolve('../main.cjs');
        delete require.cache[main];
        activate = require(main);
    } finally { Module._load = originalLoad; }
    const handlers = new Map();
    const disposers = [];
    const api = { secrets, rpc: { handle(name, handler) { handlers.set(name, handler); }, send(name, payload) { state.events.push({ name, payload }); } }, onDispose(fn) { disposers.push(fn); } };
    return { state, server, client, account, change, handlers, disposers, get accountOptions() { return accountOptions; }, activate: () => activate(api), dispose: async () => { for (const fn of [...disposers].reverse()) await fn(); } };
}

test('activate registers account and media RPCs and maps upstream URL to a local token with bounded TTL', async () => {
    const f = fixture();
    await f.activate();
    assert.deepEqual([...f.handlers.keys()].sort(), ['account.check', 'account.logout', 'account.open', 'account.status', 'details', 'release', 'resolve', 'search']);
    assert.deepEqual(await f.handlers.get('search')('music'), [{ title: 'music' }]);
    assert.equal((await f.handlers.get('details')(BV)).pages[0].cid, 123);
    const before = Date.now();
    const result = await f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    assert.equal(result.url, 'http://127.0.0.1:3000/media/token-1');
    assert.equal(result.duration, 42);
    assert.ok(result.expiresAt > before && result.expiresAt <= Date.now() + 20 * 60 * 1000);
    assert.equal(f.state.issued[0].url, UPSTREAM);
    assert.ok(f.state.issued[0].ttl > 0 && f.state.issued[0].ttl <= 20 * 60 * 1000);
    await f.dispose();
});

test('resolve verifies CID belongs to BV and never issues for a mismatch', async () => {
    const f = fixture();
    await f.activate();
    await assert.rejects(f.handlers.get('resolve')({ bvid: BV, cid: 999 }), /^Error: bili:invalid-response$/);
    assert.equal(f.state.resolved.length, 0);
    assert.equal(f.state.issued.length, 0);
    await f.dispose();
});

test('resolve rejects malformed BV/CID without contacting client', async () => {
    const f = fixture();
    await f.activate();
    for (const input of [null, {}, { bvid: 'av1', cid: 123 }, { bvid: BV, cid: '123' }, { bvid: BV, cid: 0 }, { bvid: BV, cid: Number.MAX_SAFE_INTEGER + 1 }]) {
        await assert.rejects(f.handlers.get('resolve')(input), /^Error: bili:invalid-response$/);
    }
    assert.equal(f.state.detailsCalls.length, 0);
    await f.dispose();
});

test('release only revokes URLs issued by this activation, once', async () => {
    const f = fixture();
    await f.activate();
    const result = await f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    for (const url of [UPSTREAM, 'http://127.0.0.1:3000/media/foreign', result.url + '?x', null, {}]) await f.handlers.get('release')(url);
    assert.deepEqual(f.state.revoked, []);
    await f.handlers.get('release')(result.url);
    await f.handlers.get('release')(result.url);
    assert.deepEqual(f.state.revoked, [result.url]);
    await f.dispose();
});

test('dispose is idempotent, closes client/server and rejects all later calls', async () => {
    const f = fixture();
    await f.activate();
    await f.dispose();
    await f.dispose();
    assert.equal(f.state.clientClosed, 1);
    assert.equal(f.state.serverClosed, 1);
    for (const [name, input] of [['search', 'mv'], ['details', BV], ['resolve', { bvid: BV, cid: 123 }], ['release', 'http://127.0.0.1:3000/media/foreign']]) await assert.rejects(Promise.resolve().then(() => f.handlers.get(name)(input)), /stopped|closed/i);
});

test('disposal during server startup closes the late server without registering RPCs', async () => {
    const start = deferred();
    const f = fixture({ start });
    const pending = f.activate();
    const disposal = f.dispose();
    assert.equal(f.state.clientClosed, 1);
    start.resolve(f.server);
    await Promise.all([pending, disposal]);
    assert.equal(f.state.serverClosed, 1);
    assert.equal(f.handlers.size, 0);
});

test('failed server startup closes client and does not leave an active disposer', async () => {
    const start = deferred();
    const f = fixture({ start });
    const pending = f.activate();
    start.reject(new Error('listen failed'));
    await assert.rejects(pending, { message: 'bili:unavailable' });
    await f.dispose();
    assert.equal(f.state.clientClosed, 1);
    assert.equal(f.handlers.size, 0);
});

test('metadata completion after dispose cannot start resolving media', async () => {
    const details = deferred();
    const f = fixture({ client: { details: () => details.promise } });
    await f.activate();
    const pending = f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    await f.dispose();
    details.resolve({ bvid: BV, pages: [{ cid: 123 }] });
    await assert.rejects(pending, /stopped|closed/i);
    assert.equal(f.state.resolved.length, 0);
    assert.equal(f.state.issued.length, 0);
});

test('playurl completion after dispose cannot issue a token', async () => {
    const media = deferred();
    const entered = deferred();
    const f = fixture({ client: { resolve() { entered.resolve(); return media.promise; } } });
    await f.activate();
    const pending = f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    await entered.promise;
    await f.dispose();
    media.resolve({ url: UPSTREAM, duration: 42 });
    await assert.rejects(pending, /stopped|closed/i);
    assert.equal(f.state.issued.length, 0);
});

test('platform errors propagate through RPC instead of issuing a token', async () => {
    const f = fixture({ client: { resolve: async () => { throw new Error('bili:risk-control'); } } });
    await f.activate();
    await assert.rejects(f.handlers.get('resolve')({ bvid: BV, cid: 123 }), { message: 'bili:risk-control' });
    assert.equal(f.state.issued.length, 0);
    await f.dispose();
});

test('details ownership lookup is not cached without bounds (fresh lookup per resolve)', async () => {
    const f = fixture();
    await f.activate();
    for (let i = 0; i < 3; i++) await f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    assert.equal(f.state.detailsCalls.length, 3);
    await f.dispose();
});

test('outstanding token bookkeeping is bounded by revoking the oldest token', async () => {
    const f = fixture();
    await f.activate();
    for (let i = 0; i < 129; i++) await f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    assert.deepEqual(f.state.revoked, ['http://127.0.0.1:3000/media/token-1']);
    await f.dispose();
});

test('account RPCs expose only safe snapshot and status never implicitly verifies', async () => {
    let checked = 0;
    const f = fixture({ initialChange: { loggedIn: false, name: '', status: 'idle', revision: 0, cookie: 'secret' }, account: { async check() { checked++; return { loggedIn: true, name: 'UP', status: 'logged-in', revision: 1, cookie: 'secret' }; } } });
    await f.activate();
    assert.equal(await f.state.clients[0].options.getCookie(), 'SESSDATA=secret');
    assert.deepEqual(await f.handlers.get('account.status')(), { loggedIn: false, name: '', status: 'idle', revision: 0 });
    assert.equal(checked, 0);
    assert.deepEqual(await f.handlers.get('account.check')(), { loggedIn: true, name: 'UP', status: 'logged-in', revision: 1 });
    await f.handlers.get('account.open')('ignored-cookie');
    await f.handlers.get('account.logout')('ignored-cookie');
    assert.equal(JSON.stringify(f.state.events).includes('secret'), false);
    await f.dispose();
    assert.equal(f.state.accountDisposed, 1);
});

test('status waits for account ready without networking', async () => {
    const ready = deferred();
    const f = fixture({ ready });
    const activation = f.activate();
    ready.resolve();
    await activation;
    assert.equal((await f.handlers.get('account.status')()).status, 'idle');
    await f.dispose();
});

test('failed account restore preserves status and logout recovery without disabling mod', async () => {
    const ready = deferred();
    let loggedOut = false;
    const failed = { loggedIn: false, name: '', status: 'error', revision: 0 };
    const recovered = { loggedIn: false, name: '', status: 'logged-out', revision: 1 };
    const f = fixture({ ready, account: {
        snapshot: () => loggedOut ? recovered : failed,
        async logout() { loggedOut = true; return recovered; },
    } });
    const activation = f.activate();
    ready.reject(new Error('bili:credential-storage'));
    await activation;
    assert.deepEqual(await f.handlers.get('account.status')(), failed);
    assert.deepEqual(await f.handlers.get('account.logout')(), recovered);
    assert.deepEqual(await f.handlers.get('account.status')(), recovered);
    assert.equal(f.state.accountDisposed, 0);
    await f.dispose();
});

test('credential revision closes old client, revokes tokens and replaces provider', async () => {
    const f = fixture();
    await f.activate();
    const issued = await f.handlers.get('resolve')({ bvid: BV, cid: 123 });
    f.change({ loggedIn: true, name: 'UP', status: 'logged-in', revision: 1, cookie: 'secret' });
    assert.equal(f.state.clientClosed, 1);
    assert.equal(f.state.clients.length, 2);
    assert.deepEqual(f.state.revoked, [issued.url]);
    assert.deepEqual(f.state.events.at(-1), { name: 'account.changed', payload: { loggedIn: true, name: 'UP', status: 'logged-in', revision: 1 } });
    f.change({ loggedIn: true, name: 'UP', status: 'checking', revision: 1 });
    assert.equal(f.state.clients.length, 2);
    await f.dispose();
});

for (const phase of ['search', 'details', 'resolve']) {
    test('revision invalidates old in-flight ' + phase + ' result', async () => {
        const result = deferred();
        const entered = deferred();
        const f = fixture({ client: { [phase]() { entered.resolve(); return result.promise; } } });
        await f.activate();
        const pending = phase === 'search' ? f.handlers.get('search')('mv') : f.handlers.get('resolve')({ bvid: BV, cid: 123 });
        await entered.promise;
        f.change({ loggedIn: false, name: '', status: 'logged-out', revision: 1 });
        result.resolve(phase === 'search' ? [] : phase === 'details' ? { bvid: BV, pages: [{ cid: 123 }] } : { url: UPSTREAM, duration: 42 });
        await assert.rejects(pending, { message: 'bili:stopped' });
        assert.equal(f.state.issued.length, 0);
        await f.dispose();
    });
}

test('check completion and onChange after dispose cannot return or broadcast credentials', async () => {
    const check = deferred();
    const f = fixture({ account: { check: () => check.promise } });
    await f.activate();
    const pending = f.handlers.get('account.check')();
    await f.dispose();
    const count = f.state.events.length;
    const late = { loggedIn: true, name: 'UP', status: 'logged-in', revision: 3, cookie: 'secret' };
    f.change(late);
    check.resolve(late);
    await assert.rejects(pending, { message: 'bili:stopped' });
    assert.equal(f.state.events.length, count);
    assert.equal(f.state.clients.length, 1);
});

for (const operation of ['search', 'check']) {
    test('RPC redacts arbitrary ' + operation + ' errors including forged safe prefix', async () => {
        const fail = async () => { throw new Error('bili:network SESSDATA=secret', { cause: new Error('secret') }); };
        const f = fixture({ client: { search: fail }, account: { check: fail } });
        await f.activate();
        await assert.rejects(f.handlers.get(operation === 'check' ? 'account.check' : 'search')('mv'), (error) => {
            assert.equal(error.message, 'bili:unavailable');
            assert.equal(error.cause, undefined);
            return true;
        });
        await f.dispose();
    });
}

test('verifyCookie uses a temporary isolated client and always closes it', async () => {
    const f = fixture({ client: { async account() { return { loggedIn: true, name: 'UP' }; } } });
    await f.activate();
    assert.deepEqual(await f.accountOptions.verifyCookie('SESSDATA=temporary'), { loggedIn: true, name: 'UP' });
    const temp = f.state.clients.at(-1);
    assert.equal(await temp.options.getCookie(), 'SESSDATA=temporary');
    assert.equal(f.state.clientClosed, 1);
    await f.dispose();
});

test('verification closes on abort and rejects late account result', async () => {
    const result = deferred();
    const entered = deferred();
    const f = fixture({ client: { account() { entered.resolve(); return result.promise; } } });
    await f.activate();
    const signal = new AbortController();
    const pending = f.accountOptions.verifyCookie('secret', signal.signal);
    await entered.promise;
    signal.abort();
    assert.equal(f.state.clientClosed, 1);
    result.resolve({ loggedIn: true, name: 'UP' });
    await assert.rejects(pending, { message: 'bili:stopped' });
    await f.dispose();
});

test('dispose synchronously closes account and verification before server await', async () => {
    const result = deferred();
    const entered = deferred();
    const close = deferred();
    const f = fixture({ client: { account() { entered.resolve(); return result.promise; } }, server: { close: () => close.promise } });
    await f.activate();
    const pending = f.accountOptions.verifyCookie('secret');
    await entered.promise;
    const disposed = f.dispose();
    assert.equal(f.state.accountDisposed, 1);
    assert.equal(f.state.clientClosed, 2);
    result.resolve({ loggedIn: true, name: 'UP' });
    await assert.rejects(pending, { message: 'bili:stopped' });
    close.resolve();
    await disposed;
    assert.equal(f.state.clientClosed, 2);
});

test('client shutdown failure still closes media server', async () => {
    const f = fixture({ client: { close() { throw Error('client close failed'); } } });
    await f.activate();
    await assert.rejects(f.dispose(), { message: 'bili:unavailable' });
    assert.equal(f.state.serverClosed, 1);
});
