import test from 'node:test';
import assert from 'node:assert/strict';

// Safe account state tests never use real credentials or browser services.
const load = () => import('../client/account.mjs').catch(() => ({}));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const state = (revision, loggedIn = true) => ({ loggedIn, name: loggedIn ? '测试用户' : '', status: loggedIn ? 'logged-in' : 'logged-out', revision });
function host() {
    const calls = []; const listeners = new Set(); let finish;
    const api = { env: { context: 'main' }, secrets: new Proxy({}, { get() { throw Error('secret access'); } }), rpc: {
        on(name, fn) { calls.push(name); listeners.add(fn); return () => listeners.delete(fn); },
        call(name) { calls.push(name); return name === 'account.status' ? new Promise(r => { finish = r; }) : Promise.resolve(state(3, false)); },
    } };
    return { api, calls, listeners, finish(value) { finish(value); }, push(value) { listeners.forEach(fn => fn(value)); } };
}

test('account controller listens before status, shares one listener and ignores older response', async () => {
    const { createAccount } = await load(); assert.equal(typeof createAccount, 'function');
    const h = host(); const account = createAccount(h.api); assert.deepEqual(h.calls, []);
    const a = account.acquire(); const b = account.acquire(); assert.deepEqual(h.calls, ['account.changed', 'account.status']);
    h.push({ ...state(2), cookie: 'must-not-retain' }); h.finish(state(1, false)); await flush();
    assert.deepEqual(account.get().state, state(2)); assert.ok(!JSON.stringify(account.get()).includes('must-not-retain'));
    a(); assert.equal(h.listeners.size, 1); b(); assert.equal(h.listeners.size, 0);
    const c = account.acquire(); assert.equal(h.listeners.size, 1); c(); account.dispose();
});

test('account actions only send safe RPC methods, reject unknown actions and never expose error text', async () => {
    const { createAccount } = await load(); assert.equal(typeof createAccount, 'function');
    const h = host(); const account = createAccount(h.api); const stop = account.acquire(); h.finish(state(0, false)); await flush();
    for (const action of ['open', 'check', 'logout']) await account.action(action);
    assert.deepEqual(h.calls.slice(-3), ['account.open', 'account.check', 'account.logout']);
    await account.action('anything'); assert.equal(h.calls.length, 5);
    h.api.rpc.call = async () => { throw Error('host wrapper: bili:credential-storage PRIVATE_SECRET'); };
    await account.action('open'); assert.match(account.get().message, /凭据|安全存储/); assert.ok(!account.get().message.includes('PRIVATE_SECRET'));
    stop(); account.dispose();
});

test('export account controller is inert even when acquired or actions invoked', async () => {
    const { createAccount } = await load(); assert.equal(typeof createAccount, 'function');
    const account = createAccount({ env: { context: 'export' }, get rpc() { throw Error('export RPC'); } });
    const stop = account.acquire(); await account.action('open'); stop(); account.dispose();
});

test('error mapper recognizes only complete fixed bili tokens and keeps all arbitrary text private', async () => {
    const { errorText } = await import('../client/errors.mjs').catch(() => ({})); assert.equal(typeof errorText, 'function');
    const codes = ['login-required', 'risk-control', 'unavailable', 'network', 'timeout', 'unsupported-media', 'invalid-response', 'credential-storage', 'stopped', 'auth-changed'];
    for (const code of codes) {
        const message = errorText(Error(`Error invoking remote: Error: bili:${code} SECRET`), '搜索');
        assert.match(message, /搜索/); assert.ok(!message.includes('SECRET')); assert.ok(!message.includes('bili:'));
        assert.notEqual(message, errorText(Error('SECRET'), '搜索'));
    }
    assert.equal(errorText(Error('bili:network-extra SECRET'), '搜索'), errorText(Error('SECRET'), '搜索'));
});
