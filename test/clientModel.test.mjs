import test from 'node:test';
import assert from 'node:assert/strict';

// Pure model tests run without the host or browser dependencies.
const moduleUrl = new URL('../client/model.mjs', import.meta.url);
const load = () => import(moduleUrl).catch(() => ({}));
const song = (id, title = '歌名') => ({ source: 'local', id, title, artist: '歌手', ref: 'session' });
const binding = (n = 1) => ({ bvid: 'BV1xx411c7mD', cid: n, page: 1, title: 'MV', offset: 0 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function host(initial = song('a')) {
    let state = { song: initial, position: 12, state: 'playing', duration: 200 };
    const events = new Map(); const calls = []; const saved = [];
    const api = {
        env: { context: 'main' },
        playback: { getState: () => state },
        events: { on: (name, fn) => { events.set(name, fn); return () => events.delete(name); } },
        storage: { get: async () => undefined, set: async (key, data) => saved.push(structuredClone(data)) },
        rpc: { call: async (name, ...args) => { calls.push([name, ...args]); return []; } },
    };
    return { api, calls, saved, events, change(next) { state = { ...state, song: next }; events.get('playback.songChanged')?.({ song: next }); } };
}

test('song key uses source and id, never ref, and normalizes fallback metadata', async () => {
    const { songKey } = await load(); assert.equal(typeof songKey, 'function');
    assert.equal(songKey(song('a')), songKey({ ...song('a'), title: 'rename', ref: 'other' }));
    assert.notEqual(songKey(song('a')), songKey({ ...song('a'), source: 'other' }));
    assert.equal(songKey({ title: ' ＭＶ  Song ', artist: ' A  B ' }), songKey({ title: 'mv song', artist: 'a b' }));
    assert.equal(songKey(null), null);
    assert.notEqual(songKey({ title: 'a|b', artist: 'c' }), songKey({ title: 'a', artist: 'b|c' }));
});

test('binding validation strips tokens/ref, rejects invalid fields and bounds UTF8 storage', async () => {
    const { sanitizeBindings, MAX_BINDINGS, MAX_BINDING_BYTES } = await load(); assert.equal(typeof sanitizeBindings, 'function');
    const raw = Array.from({ length: 1000 }, (_, i) => [JSON.stringify(['id', 'local', String(i)]), { ...binding(i + 1), title: '中'.repeat(300), url: 'secret', ref: 'ref' }]);
    raw.push(['invalid', { ...binding(), offset: Infinity }]);
    const entries = sanitizeBindings(raw);
    assert.ok(entries.length <= MAX_BINDINGS && entries.length > 0);
    assert.ok(new TextEncoder().encode(JSON.stringify(entries)).length <= MAX_BINDING_BYTES);
    assert.ok(entries.every(([, value]) => !('url' in value) && !('ref' in value)));
    for (const invalid of [{ cid: -1 }, { page: 0 }, { bvid: 'bad' }, { offset: '2' }, { title: {} }]) {
        assert.deepEqual(sanitizeBindings([[JSON.stringify(['id', 'local', 'x']), { ...binding(), ...invalid }]]), []);
    }
});

test('media URL and cover validators restrict loopback tokens and HTTPS Bilibili CDN', async () => {
    const { safeMediaUrl, safeCoverUrl } = await load(); assert.equal(typeof safeMediaUrl, 'function');
    assert.ok(safeMediaUrl('http://127.0.0.1:43210/media/secret-token'));
    for (const url of ['https://evil.test/video', 'http://localhost:4000/t', 'http://127.0.0.1/t', 'http://127.0.0.1:80/t', 'http://u:p@127.0.0.1:4000/t', 'http://127.0.0.1:4000/']) assert.equal(safeMediaUrl(url), null);
    assert.ok(safeCoverUrl('https://i0.hdslb.com/a.jpg'));
    for (const url of ['http://i0.hdslb.com/a', 'https://hdslb.com.evil.test/a', 'https://evil.test/a', '//i0.hdslb.com/a']) assert.equal(safeCoverUrl(url), null);
});

test('sync uses audio position plus offset, pauses outside range and clamps seek', async () => {
    const { syncTarget } = await load(); assert.equal(typeof syncTarget, 'function');
    assert.deepEqual(syncTarget({ position: 10, state: 'playing' }, -12, 80), { time: 0, playing: false });
    assert.deepEqual(syncTarget({ position: 10, state: 'playing' }, 2, 80), { time: 12, playing: true });
    assert.deepEqual(syncTarget({ position: 10, state: 'paused' }, 2, 80), { time: 12, playing: false });
    assert.deepEqual(syncTarget({ position: 10, state: 'stopped' }, 2, 80), { time: 12, playing: false });
    assert.deepEqual(syncTarget({ position: 90, state: 'playing' }, 0, 80), { time: 80, playing: false });
    assert.deepEqual(syncTarget({ position: NaN, state: 'playing' }, 0, 0), { time: 0, playing: false });
});

test('shared model ignores stale search/details responses and auto searches once per song only with open panel', async () => {
    const { createModel } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); const pending = [];
    h.api.rpc.call = (name, ...args) => { h.calls.push([name, ...args]); const d = deferred(); pending.push(d); return d.promise; };
    const model = createModel(h.api); const stop = model.acquire(); await model.ready;
    assert.equal(h.calls.length, 0);
    const close = model.openPanel(); await flush(); assert.equal(h.calls[0][0], 'search');
    h.change(song('b')); await flush(); assert.equal(h.calls.length, 2);
    pending[0].resolve([{ ...binding(), author: 'old', duration: 1 }]); await flush(); assert.equal(model.get().results.length, 0);
    pending[1].resolve([{ ...binding(), author: 'new', duration: 1 }]); await flush(); assert.equal(model.get().results[0].author, 'new');
    const details = model.select(model.get().results[0]); h.change(song('c')); await flush();
    pending[2].resolve({ bvid: binding().bvid, title: 'old', pages: [{ cid: 1, page: 1, title: 'old', duration: 20 }] }); await details;
    assert.equal(model.get().details, null);
    close(); const reopen = model.openPanel(); await flush(); assert.equal(h.calls.filter(c => c[0] === 'search').length, 3);
    reopen(); stop(); model.dispose(); assert.equal(h.events.size, 0);
});

test('model merges delayed storage before mutations and serializes writes without stale song binding', async () => {
    const { createModel, songKey } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); const read = deferred(); const write = deferred();
    h.api.storage.get = () => read.promise;
    h.api.storage.set = async (_, data) => { h.saved.push(structuredClone(data)); if (h.saved.length === 1) await write.promise; };
    const model = createModel(h.api); const stop = model.acquire();
    const first = model.bind(binding()); h.change(song('b'));
    read.resolve([[songKey(song('existing')), binding(99)]]); await first;
    const second = model.bind(binding(2)); await flush(); assert.equal(h.saved.length, 1);
    write.resolve(); await second; await model.flush();
    const stored = new Map(h.saved.at(-1)); assert.equal(stored.get(songKey(song('a'))).cid, 1); assert.equal(stored.get(songKey(song('b'))).cid, 2); assert.equal(stored.get(songKey(song('existing'))).cid, 99);
    assert.equal(model.get().binding.cid, 2); stop(); model.dispose();
});

test('load failure does not overwrite unknown saved bindings', async () => {
    const { createModel } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); h.api.storage.get = async () => { throw Error('disk'); };
    const model = createModel(h.api); const stop = model.acquire(); await model.ready;
    await model.bind(binding()); await model.flush(); assert.equal(h.saved.length, 0); assert.match(model.get().status, /保存|读取/); stop(); model.dispose();
});

test('reopening a panel after closing all mounts refreshes song and auto-searches once', async () => {
    const { createModel } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); const model = createModel(h.api); let stop = model.acquire(); let close = model.openPanel(); await model.ready; await flush(); close(); stop();
    h.change(song('b')); stop = model.acquire(); close = model.openPanel(); await flush(); assert.equal(model.get().song.id, 'b'); assert.equal(h.calls.filter(c => c[0] === 'search').length, 2); close(); stop(); model.dispose();
});

test('new search supersedes pending details and reverse-order manual searches', async () => {
    const { createModel } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); const pending = []; h.api.rpc.call = () => { const d = deferred(); pending.push(d); return d.promise; };
    const model = createModel(h.api); const stop = model.acquire(); await model.ready;
    const details = model.select(binding()); const first = model.search('first'); const second = model.search('second');
    pending[2].resolve([{ ...binding(), title: 'second' }]); await second; pending[1].resolve([{ ...binding(), title: 'first' }]); await first;
    pending[0].resolve({ bvid: binding().bvid, pages: [{ cid: 1, page: 1, title: 'late' }] }); await details;
    assert.equal(model.get().results[0].title, 'second'); assert.equal(model.get().details, null); stop(); model.dispose();
});

test('stored offset and binding changes remain captured for their original song', async () => {
    const { createModel, songKey } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); const model = createModel(h.api); const stop = model.acquire(); await model.ready; await model.bind(binding());
    const pending = model.setOffset(-2); h.change(song('b')); await pending; await model.flush(); assert.equal(new Map(h.saved.at(-1)).get(songKey(song('a'))).offset, -2); assert.equal(model.get().binding, null); stop(); model.dispose();
});

test('default and manually submitted keywords respect server 100-character bound', async () => {
    const { defaultKeyword, createModel } = await load(); assert.equal(typeof defaultKeyword, 'function');
    assert.ok(defaultKeyword(song('a', 'long'.repeat(100))).length <= 100);
    const h = host(); const model = createModel(h.api); const stop = model.acquire(); await model.ready; await model.search('x'.repeat(200)); assert.equal(h.calls[0][1].length, 100); stop(); model.dispose();
});

test('closing all users during automatic search allows same-song reopen to retry', async () => {
    const { createModel } = await load(); assert.equal(typeof createModel, 'function');
    const h = host(); const pending = [];
    h.api.rpc.call = (name, ...args) => { h.calls.push([name, ...args]); const d = deferred(); pending.push(d); return d.promise; };
    const model = createModel(h.api); let stop = model.acquire(); let close = model.openPanel(); await model.ready; await flush();
    assert.equal(h.calls.length, 1); assert.equal(model.get().busy, true);
    close(); stop(); assert.equal(model.get().status, ''); assert.deepEqual(model.get().results, []);
    stop = model.acquire(); close = model.openPanel(); await flush(); assert.equal(h.calls.length, 2);
    pending[0].resolve([{ ...binding(), title: 'stale' }]); await flush(); assert.equal(model.get().results.length, 0);
    pending[1].resolve([{ ...binding(), title: 'fresh' }]); await flush(); assert.equal(model.get().results[0].title, 'fresh');
    close(); stop(); stop = model.acquire(); close = model.openPanel(); await flush(); assert.equal(h.calls.length, 2);
    close(); stop(); model.dispose();
});

test('authChanged invalidates pending search/details without automatically re-searching or dropping bindings', async () => {
    const { createModel } = await load(); const h = host(); const pending = [];
    h.api.rpc.call = (name, ...args) => { h.calls.push([name, ...args]); const d = deferred(); pending.push(d); return d.promise; };
    const model = createModel(h.api); const stop = model.acquire(); await model.ready; await model.bind(binding());
    const search = model.search('query'); const details = model.select(binding());
    assert.equal(typeof model.authChanged, 'function'); model.authChanged(2);
    pending[0].resolve([{ ...binding(), title: 'stale' }]); pending[1].resolve({ bvid: binding().bvid, pages: [{ cid: 1, page: 1, title: 'stale' }] }); await Promise.all([search, details]);
    assert.equal(model.get().authRevision, 2); assert.equal(model.get().busy, false); assert.deepEqual(model.get().results, []); assert.equal(model.get().details, null); assert.equal(model.get().binding.cid, 1); assert.equal(h.calls.length, 2);
    model.authChanged(1); assert.equal(model.get().authRevision, 2); stop(); model.dispose();
});

for (const [method, operation] of [['search', '搜索'], ['select', '分P']]) test(`${method} reports whitelisted error reason without arbitrary backend text`, async () => {
    const { createModel } = await load(); const h = host(); h.api.rpc.call = async () => { throw Error('RPC wrapped: bili:login-required PRIVATE_SECRET'); };
    const model = createModel(h.api); const stop = model.acquire(); await model.ready; await model[method](method === 'search' ? 'q' : binding());
    assert.match(model.get().status, new RegExp(operation)); assert.match(model.get().status, /登录/); assert.ok(!model.get().status.includes('PRIVATE_SECRET')); stop(); model.dispose();
});

test('malformed search response reports invalid data instead of a successful empty search', async () => {
    const { createModel } = await load(); const h = host(); h.api.rpc.call = async () => ({ unexpected: true });
    const model = createModel(h.api); const stop = model.acquire(); await model.ready; await model.search('q');
    assert.match(model.get().status, /数据无效/); assert.deepEqual(model.get().results, []); stop(); model.dispose();
});

export { host, song, binding, deferred, flush };
