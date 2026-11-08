const electron = require('electron');
const { createAccount } = require('./lib/account.cjs');
const { createBilibiliClient } = require('./lib/bilibili.cjs');
const { createMediaServer } = require('./lib/media-server.cjs');

// Connect account-scoped API requests and RPC to this activation's short-lived media tokens.
const TOKEN_TTL_MS = 20 * 60 * 1000;
const MAX_TOKENS = 128;
const BV_PATTERN = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
const SAFE_ERROR = /^bili:(?:login-required|risk-control|unavailable|network|timeout|unsupported-media|invalid-response|credential-storage|stopped)$/;
const STATUSES = new Set(['idle', 'checking', 'logged-in', 'logged-out', 'error', 'disposed']);
const safeError = (error) => new Error(SAFE_ERROR.test(error?.message) ? error.message : 'bili:unavailable');
const safeState = (state) => ({
    loggedIn: state?.loggedIn === true,
    name: typeof state?.name === 'string' ? state.name : '',
    status: STATUSES.has(state?.status) ? state.status : 'error',
    revision: Number.isSafeInteger(state?.revision) && state.revision >= 0 ? state.revision : 0,
});

module.exports = async function activate(api) {
    const tokens = new Map();
    const verifiers = new Set();
    let account;
    let client;
    let server;
    let stopped = false;
    let cleanup;
    let revision;
    let generation = 0;

    function ensureActive(expected = generation) {
        if (stopped || expected !== generation) throw new Error('bili:stopped');
    }

    function revokeAll() {
        for (const url of tokens.keys()) server?.revoke(url);
        tokens.clear();
    }

    function dispose() {
        if (stopped) return cleanup;
        stopped = true;
        // Dispose account and clients synchronously, even when server.close is asynchronous.
        let failure;
        const attempt = (run) => { try { run(); } catch (error) { failure ||= safeError(error); } };
        attempt(() => account?.dispose());
        attempt(() => client?.close());
        for (const close of verifiers) attempt(close);
        verifiers.clear();
        attempt(revokeAll);
        cleanup = (async () => {
            try { if (server) await server.close(); }
            catch (error) { failure ||= safeError(error); }
            if (failure) throw failure;
        })();
        return cleanup;
    }

    // Register before any await, including account readiness or media server startup.
    api.onDispose(dispose);
    const cookieProvider = () => account.getCookie();
    function onChange(input) {
        if (stopped) return;
        const state = safeState(input);
        revokeAll();
        if (revision !== undefined && revision !== state.revision) {
            generation++;
            client?.close();
            if (account) client = createBilibiliClient({ getCookie: cookieProvider });
        }
        revision = state.revision;
        api.rpc.send('account.changed', state);
    }
    async function verifyCookie(cookie, signal) {
        ensureActive();
        if (signal?.aborted) throw new Error('bili:stopped');
        const verifier = createBilibiliClient({ getCookie: async () => cookie });
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            verifiers.delete(close);
            verifier.close();
        };
        verifiers.add(close);
        signal?.addEventListener('abort', close, { once: true });
        try {
            const result = await verifier.account();
            ensureActive();
            if (signal?.aborted) throw new Error('bili:stopped');
            return { loggedIn: result.loggedIn === true, name: typeof result.name === 'string' ? result.name : '' };
        } catch (error) { throw safeError(error); }
        finally {
            signal?.removeEventListener('abort', close);
            close();
        }
    }

    try {
        account = createAccount({ electron, secrets: api.secrets, verifyCookie, onChange });
        if (stopped) { account.dispose(); return; }
        revision = safeState(account.snapshot()).revision;
        client = createBilibiliClient({ getCookie: cookieProvider });
        server = await createMediaServer();
        if (stopped) { await server.close(); return; }
        // Broken saved credentials must still allow status/logout recovery.
        try { await account.ready; } catch {}
        if (stopped) return;
        const handle = (name, run, scoped = false) => api.rpc.handle(name, async (...args) => {
            try {
                ensureActive();
                const expected = generation;
                const activeClient = client;
                const check = () => ensureActive(scoped ? expected : generation);
                const result = await run(activeClient, check, ...args);
                check();
                return result;
            } catch (error) { throw stopped ? new Error('bili:stopped') : safeError(error); }
        });

        handle('account.status', async () => {
            try { await account.ready; } catch {}
            ensureActive();
            return safeState(account.snapshot());
        });
        for (const method of ['open', 'check', 'logout']) {
            handle(`account.${method}`, async () => safeState(await account[method]()));
        }
        handle('search', (activeClient, _check, keyword) => activeClient.search(keyword), true);
        handle('details', (activeClient, _check, bvid) => activeClient.details(bvid), true);
        handle('resolve', async (activeClient, check, input) => {
            if (!input || typeof input !== 'object') throw new Error('bili:invalid-response');
            const { bvid, cid } = input;
            if (typeof bvid !== 'string' || !BV_PATTERN.test(bvid) || !Number.isSafeInteger(cid) || cid <= 0) throw new Error('bili:invalid-response');
            // No metadata cache: every issued token uses a fresh, bounded ownership lookup.
            const metadata = await activeClient.details(bvid);
            check();
            if (metadata.bvid !== bvid || !metadata.pages.some((page) => page.cid === cid)) throw new Error('bili:invalid-response');
            const media = await activeClient.resolve({ bvid, cid });
            check();
            const now = Date.now();
            for (const [url, expiresAt] of tokens) {
                if (expiresAt <= now) {
                    server.revoke(url);
                    tokens.delete(url);
                }
            }
            if (tokens.size >= MAX_TOKENS) {
                const oldest = tokens.keys().next().value;
                server.revoke(oldest);
                tokens.delete(oldest);
            }
            const expiresAt = now + TOKEN_TTL_MS;
            const url = server.issue(media.url, TOKEN_TTL_MS);
            tokens.set(url, expiresAt);
            return { url, duration: media.duration, expiresAt };
        }, true);
        handle('release', (_client, _check, localUrl) => {
            if (typeof localUrl === 'string' && tokens.has(localUrl)) {
                server.revoke(localUrl);
                tokens.delete(localUrl);
            }
            return null;
        });
    } catch (error) {
        try { await dispose(); } catch {}
        throw safeError(error);
    }
};
