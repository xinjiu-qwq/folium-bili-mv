import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM/Folium harness: intentionally throws on HTML injection and unknown host APIs.
export class Element {
    constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.textContent = ''; this.value = ''; this.disabled = false; this.readyState = 0; this.currentTime = 0; this.duration = 120; this.paused = true; this.src = ''; this.playCalls = 0; }
    set innerHTML(_) { throw Error('innerHTML is forbidden'); }
    append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
    appendChild(c) { this.append(c); return c; }
    replaceChildren(...children) { this.children.forEach(c => { c.parent = null; }); this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    removeAttribute(k) { delete this.attributes[k]; if (k === 'src') this.src = ''; }
    addEventListener(k, fn) { const set = this.listeners.get(k) ?? new Set(); set.add(fn); this.listeners.set(k, set); }
    removeEventListener(k, fn) { this.listeners.get(k)?.delete(fn); }
    dispatch(k) { for (const fn of [...(this.listeners.get(k) ?? [])]) fn({ preventDefault() {}, target: this }); }
    pause() { this.paused = true; }
    play() { this.playCalls++; if (this.rejectPlay) return Promise.reject(Error('autoplay')); this.paused = false; return Promise.resolve(); }
    load() { this.readyState = 0; }
    all(tag) { return this.children.flatMap(c => [ ...(c.tagName === tag ? [c] : []), ...c.all(tag) ]); }
}
export function harness({ context = 'main', stored, rpc } = {}) {
    const document = { createElement: tag => new Element(tag, document) };
    const events = new Map(); const timers = new Set(); const definitions = []; const sections = []; const calls = []; const saved = []; const messages = new Map();
    const account = { loggedIn: false, name: '', status: 'logged-out', revision: 0 };
    const song = id => ({ source: 'local', id, title: '<img onerror=evil()>', artist: '歌手', ref: 'never-store' });
    let state = { song: song('a'), state: 'playing', position: 12, duration: 120 };
    const api = {
        env: { context },
        registries: { backgrounds: { register: def => { definitions.push(def); return { unregister() {} }; } }, settingsSections: { register: def => { sections.push(def); return { unregister() { def.unregistered = true; } }; } } },
        secrets: new Proxy({}, { get() { throw Error('client must never access secrets'); } }),
        playback: { getState() { assert.equal(context, 'main'); return state; } },
        events: { on(name, fn) { assert.equal(context, 'main'); const set = events.get(name) ?? new Set(); set.add(fn); events.set(name, set); return () => set.delete(fn); } },
        storage: { async get() { assert.equal(context, 'main'); return stored; }, async set(_, data) { saved.push(data); } },
        rpc: { on(name, fn) { assert.equal(context, 'main'); const set = messages.get(name) ?? new Set(); set.add(fn); messages.set(name, set); return () => set.delete(fn); }, async call(name, ...args) { assert.equal(context, 'main'); calls.push([name, ...args]); return rpc ? rpc(name, ...args) : name.startsWith('account.') ? account : name === 'resolve' ? { url: 'http://127.0.0.1:43210/media/token', duration: 120, expiresAt: Date.now() + 60_000 } : []; } },
        every(ms, fn) { assert.equal(ms, 500); timers.add(fn); return () => timers.delete(fn); },
    };
    const changes = new Set(); const settingsChanges = new Set(); let values = { fit: 'contain', dim: 0.35 };
    const ctx = {
        staticMode: false, locale: 'zh-CN', isPaused: () => state.state !== 'playing',
        getTheme: () => ({ primaryColor: '#eee', secondaryColor: '#aaa', backgroundColor: '#222', isDaylight: false }),
        getSettings: () => values,
        settings: { get: () => values, set(patch) { values = { ...values, ...patch }; settingsChanges.forEach(fn => fn()); changes.forEach(fn => fn()); }, onChange(fn) { settingsChanges.add(fn); return () => settingsChanges.delete(fn); } },
        onChange(fn) { changes.add(fn); return () => changes.delete(fn); },
        onDispose() {},
    };
    return { api, ctx, definitions, sections, messages, push(value) { messages.get('account.changed')?.forEach(fn => fn(value)); }, document, calls, saved, timers, events, changes, settingsChanges, root: () => document.createElement('div'), tick() { timers.forEach(fn => fn()); }, change(id) { state = { ...state, song: song(id) }; events.get('playback.songChanged')?.forEach(fn => fn({ song: state.song })); }, state(patch) { state = { ...state, ...patch }; const name = 'position' in patch ? 'playback.seeked' : 'playback.stateChanged'; events.get(name)?.forEach(fn => fn({ state: state.state, position: state.position })); }, song };
}
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const load = () => import('../client.mjs').catch(() => ({}));
const stored = [[JSON.stringify(['id', 'local', 'a']), { bvid: 'BV1xx411c7mD', cid: 1, page: 1, title: 'MV', offset: 2 }]];
const button = (root, text) => root.all('button').find(n => n.textContent === text);

test('account settings and MV panel share safe account state and dispose all subscriptions', async () => {
    const { default: activate } = await load(); const h = harness({ stored }); const stop = activate(h.api);
    assert.equal(h.sections.length, 1); const section = h.sections[0]; assert.equal(section.id, 'account'); assert.equal(section.label['zh-CN'], 'B站账号');
    assert.ok(section.settings.some(s => s.type === 'secret' && s.key === 'bilibili-session'));
    assert.equal(h.calls.length, 0); const a = h.root(); const b = h.root();
    const ca = section.settingsPanel(a, h.ctx); const cb = h.definitions[0].settingsPanel(b, h.ctx); await flush();
    assert.equal(h.calls.filter(c => c[0] === 'account.status').length, 1); assert.equal(h.messages.get('account.changed').size, 1);
    assert.equal(a.all('input').length, 0);
    h.push({ loggedIn: true, name: '<b>测试用户</b>', status: 'logged-in', revision: 1 }); await flush();
    for (const panel of [a, b]) assert.ok(panel.all('p').some(n => n.textContent.includes('<b>测试用户</b>')));
    for (const [label, name] of [['打开官方登录窗', 'open'], ['检查登录', 'check'], ['退出登录', 'logout']]) { button(a, label).dispatch('click'); await flush(); assert.ok(h.calls.some(c => c[0] === `account.${name}`)); }
    ca(); assert.equal(h.messages.get('account.changed').size, 1); cb(); assert.equal(h.messages.get('account.changed').size, 0); stop(); assert.equal(section.unregistered, true); assert.equal(h.changes.size, 0);
});

test('auth revision clears a loaded token without automatic resolving until explicit retry', async () => {
    const { default: activate } = await load(); const h = harness({ stored }); const stop = activate(h.api); const root = h.root(); const panel = h.root();
    const end = h.definitions[0].mount(root, h.ctx); const close = h.definitions[0].settingsPanel(panel, h.ctx); await flush();
    const video = root.all('video')[0]; assert.ok(video.src);
    h.push({ loggedIn: true, name: '用户', status: 'logged-in', revision: 1 }); await flush();
    assert.equal(video.src, ''); assert.equal(h.calls.filter(c => c[0] === 'release').length, 1); h.tick(); video.dispatch('error'); await flush();
    assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 1); assert.ok(panel.all('p').some(n => /账号.*变化.*重试播放/.test(n.textContent)));
    button(panel, '重试播放').dispatch('click'); await flush(); assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 2); assert.ok(video.src); close(); end(); stop();
});

test('auth revision invalidates pending resolve and releases its late URL without replay', async () => {
    const { default: activate } = await load(); let finish;
    const h = harness({ stored, rpc: name => name === 'resolve' ? new Promise(r => { finish = r; }) : name.startsWith('account.') ? { loggedIn: false, name: '', status: 'logged-out', revision: 0 } : [] });
    const stop = activate(h.api); const root = h.root(); const end = h.definitions[0].mount(root, h.ctx); await flush();
    h.push({ loggedIn: false, name: '', status: 'logged-out', revision: 1 });
    finish({ url: 'http://127.0.0.1:43210/media/old', duration: 120, expiresAt: Date.now() + 10000 }); await flush();
    assert.equal(root.all('video')[0].src, ''); assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 1); assert.equal(h.calls.filter(c => c[0] === 'release').length, 1); end(); stop();
});

test('settings panels in static/export contexts call no main APIs', async () => {
    const { default: activate } = await load();
    for (const context of ['main', 'export']) {
        const h = harness({ context }); const stop = activate(h.api);
        for (const def of [h.definitions[0], h.sections[0]]) { assert.ok(def); const root = h.root(); const close = def.settingsPanel(root, { ...h.ctx, staticMode: true }); close(); }
        assert.equal(h.calls.length, 0); assert.equal(h.messages.size, 0); stop();
    }
});

test('unsupported AVC capability is actionable and never causes resolve or automatic retry', async () => {
    const { default: activate } = await load(); const h = harness({ stored });
    const create = h.document.createElement; h.document.createElement = tag => { const node = create(tag); if (tag === 'video') node.canPlayType = type => { assert.equal(type, 'video/mp4; codecs="avc1.42E01E"'); return ''; }; return node; };
    const stop = activate(h.api); const root = h.root(); const panel = h.root(); const end = h.definitions[0].mount(root, h.ctx); const close = h.definitions[0].settingsPanel(panel, h.ctx); await flush();
    assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 0); assert.ok(panel.all('p').some(n => /不支持.*H\.264|不支持.*AVC/.test(n.textContent))); h.tick(); await flush(); assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 0); close(); end(); stop();
});

for (const [code, pattern] of [[2, /网络/], [3, /解码/], [4, /格式|编码/]]) test(`media error ${code} has specific safe explanation and bounded recovery`, async () => {
    const { default: activate } = await load(); const h = harness({ stored }); const stop = activate(h.api); const root = h.root(); const panel = h.root();
    const end = h.definitions[0].mount(root, h.ctx); const close = h.definitions[0].settingsPanel(panel, h.ctx); await flush();
    const video = root.all('video')[0]; video.error = { code, message: 'PRIVATE_SECRET' }; video.dispatch('error'); await flush(); video.dispatch('error'); await flush();
    const statuses = panel.all('p').map(p => p.textContent).join(' '); assert.match(statuses, pattern); assert.ok(!statuses.includes('PRIVATE_SECRET')); assert.ok(h.calls.filter(c => c[0] === 'resolve').length <= 2); close(); end(); stop();
});

test('registers mv background with settings schema, no stage layers; export and staticMode never call main APIs', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    for (const mode of ['export', 'static']) {
        const h = harness({ context: mode === 'export' ? 'export' : 'main' });
        if (mode === 'static') for (const key of ['playback', 'events', 'storage', 'rpc']) h.api[key] = new Proxy({}, { get() { throw Error('static main API'); } });
        const stop = activate(h.api); const def = h.definitions[0];
        assert.equal(def.id, 'mv'); assert.equal(def.label['zh-CN'], 'B站 MV'); assert.ok(def.settings.length);
        const root = h.root(); const end = def.mount(root, { ...h.ctx, staticMode: mode === 'static' }); await flush();
        assert.equal(root.all('video').length, 0); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); end(); stop();
    }
});

test('one active video across multiple mounts; metadata gating, audio position sync and complete teardown', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ stored }); const stop = activate(h.api); const def = h.definitions[0]; const root = h.root(); const other = h.root();
    const end = def.mount(root, h.ctx); const endOther = def.mount(other, h.ctx); await flush();
    assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 1); assert.equal(h.timers.size, 1);
    const video = root.all('video')[0]; assert.ok(video); assert.equal(other.all('video').length, 0);
    assert.equal(video.muted, true); assert.equal(video.currentTime, 0); assert.equal(video.playCalls, 0);
    video.readyState = 1; video.dispatch('loadedmetadata'); await flush(); assert.equal(video.currentTime, 14); assert.equal(video.paused, false);
    h.state({ state: 'paused' }); assert.equal(video.paused, true); h.state({ position: 30 }); assert.equal(video.currentTime, 32);
    h.state({ state: 'playing' }); await flush(); assert.equal(video.paused, false);
    h.state({ position: 150 }); assert.equal(video.currentTime, 120); assert.equal(video.paused, true);
    endOther(); end(); stop(); await flush();
    assert.equal(video.src, ''); assert.equal(h.timers.size, 0); assert.ok([...h.events.values()].every(s => s.size === 0)); assert.equal(h.changes.size, 0);
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 1); assert.ok([...video.listeners.values()].every(s => s.size === 0));
});

test('unmount hands ownership to next background without duplicate requests while mounted', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ stored }); const stop = activate(h.api); const a = h.root(); const b = h.root();
    const ea = h.definitions[0].mount(a, h.ctx); const eb = h.definitions[0].mount(b, h.ctx); await flush(); ea(); await flush();
    assert.equal(b.all('video').length, 1); assert.equal(h.timers.size, 1); assert.equal(h.calls.filter(c => c[0] === 'release').length, 1);
    eb(); stop();
});

test('late resolve after song switch is released and never attached', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    let resolve; const pending = new Promise(r => { resolve = r; });
    const h = harness({ stored, rpc: name => name === 'resolve' ? pending : undefined }); const stop = activate(h.api); const root = h.root(); const end = h.definitions[0].mount(root, h.ctx); await flush();
    h.change('b'); resolve({ url: 'http://127.0.0.1:43210/media/late', duration: 100, expiresAt: Date.now() + 10000 }); await flush();
    assert.equal(root.all('video')[0].src, ''); assert.equal(h.calls.filter(c => c[0] === 'release').length, 1); end(); stop();
});

test('media errors and expiry trigger at most one automatic re-resolve', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ stored }); const stop = activate(h.api); const root = h.root(); const end = h.definitions[0].mount(root, h.ctx); await flush();
    const video = root.all('video')[0]; video.dispatch('error'); await flush(); video.dispatch('error'); await flush(); h.tick(); await flush();
    assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 2); assert.equal(video.src, ''); end(); stop();
});

test('play rejection reports actionable message and only explicit retry retries play', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ stored }); const stop = activate(h.api); const root = h.root(); const panel = h.root();
    const end = h.definitions[0].mount(root, h.ctx); const close = h.definitions[0].settingsPanel(panel, h.ctx); await flush();
    const video = root.all('video')[0]; video.rejectPlay = true; video.readyState = 1; video.dispatch('loadedmetadata'); await flush();
    const status = panel.all('p').find(n => n.attributes['aria-live']); assert.match(status.textContent, /播放.*重试|重试.*播放/);
    h.tick(); h.tick(); await flush(); assert.equal(video.playCalls, 1);
    video.rejectPlay = false; button(panel, '重试播放').dispatch('click'); await flush(); assert.equal(video.playCalls, 2);
    close(); end(); stop();
});

test('expired leases re-resolve once and invalid remote media is never loaded', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const originalNow = Date.now; let clock = originalNow(); Date.now = () => clock;
    try {
        const h = harness({ stored }); const stop = activate(h.api); const root = h.root(); const end = h.definitions[0].mount(root, h.ctx); await flush();
        clock += 61_000; h.tick(); await flush(); clock += 61_000; h.tick(); await flush(); h.tick(); await flush();
        assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 2); assert.equal(root.all('video')[0].src, ''); end(); stop();
        const bad = harness({ stored, rpc: () => ({ url: 'https://evil.test/media', duration: 20, expiresAt: clock + 60_000 }) }); const off = activate(bad.api); const dest = bad.root(); const unmount = bad.definitions[0].mount(dest, bad.ctx); await flush();
        assert.equal(dest.all('video')[0].src, ''); bad.tick(); await flush(); assert.equal(bad.calls.filter(c => c[0] === 'resolve').length, 1); unmount(); off();
    } finally { Date.now = originalNow; }
});

test('disable during pending resolve clears all resources and releases eventual lease', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    let finish; const pending = new Promise(r => { finish = r; }); const h = harness({ stored, rpc: name => name === 'resolve' ? pending : undefined });
    const stop = activate(h.api); const root = h.root(); const end = h.definitions[0].mount(root, h.ctx); await flush(); stop();
    finish({ url: 'http://127.0.0.1:43210/media/pending', duration: 60, expiresAt: Date.now() + 60_000 }); await flush(); end();
    assert.equal(root.all('video').length, 0); assert.equal(h.timers.size, 0); assert.equal(h.calls.filter(c => c[0] === 'release').length, 1); assert.ok([...h.events.values()].every(set => !set.size));
});

test('stale browser error after song change cannot retry another song lease', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ stored }); const stop = activate(h.api); const root = h.root(); const end = h.definitions[0].mount(root, h.ctx); await flush();
    const video = root.all('video')[0]; h.change('b'); video.dispatch('error'); await flush(); assert.equal(h.calls.filter(c => c[0] === 'resolve').length, 1); end(); stop();
});

test('shadow-root focused offset edit survives background status updates', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ stored }); const stop = activate(h.api); const panel = h.root();
    const close = h.definitions[0].settingsPanel(panel, h.ctx); await flush();
    const section = panel.children[0]; const offset = panel.all('input').find(n => n.type === 'number');
    section.getRootNode = () => ({ activeElement: offset });
    h.document.activeElement = panel; offset.value = '-12.';
    button(panel, '重试播放').dispatch('click'); await flush();
    assert.equal(offset.value, '-12.'); close(); stop();
});

test('settings panel safely renders result text and covers, editable query, pages, binding and per-song offset', async () => {
    const { default: activate } = await load(); assert.equal(typeof activate, 'function');
    const h = harness({ rpc: (name) => name === 'search' ? [{ bvid: 'BV1xx411c7mD', title: '<script>evil</script>', author: 'up', duration: 60, cover: 'https://i0.hdslb.com/a.jpg' }] : name === 'details' ? { bvid: 'BV1xx411c7mD', title: 'MV', pages: [{ cid: 2, page: 2, title: '<b>part</b>', duration: 60 }] } : undefined });
    const stop = activate(h.api); const panel = h.root(); const close = h.definitions[0].settingsPanel(panel, h.ctx); await flush();
    const query = panel.all('input').find(n => n.type === 'search'); assert.match(query.value, /MV$/); query.value = 'custom'; query.dispatch('input'); button(panel, '搜索').dispatch('click'); await flush(); assert.deepEqual(h.calls.filter(c => c[0] === 'search').at(-1), ['search', 'custom']);
    assert.ok(panel.all('span').some(n => n.textContent === '<script>evil</script>')); const img = panel.all('img')[0]; assert.equal(img.referrerPolicy, 'no-referrer'); img.dispatch('error');
    button(panel, '选择视频').dispatch('click'); await flush(); button(panel, '绑定此分P').dispatch('click'); await flush();
    const offset = panel.all('input').find(n => n.type === 'number'); offset.value = '-3.5'; offset.dispatch('change'); await flush();
    assert.equal(h.saved.at(-1)[0][1].offset, -3.5); assert.equal(h.saved.at(-1)[0][1].cid, 2); assert.ok(!JSON.stringify(h.saved).includes('never-store'));
    button(panel, '解除绑定').dispatch('click'); await flush(); assert.deepEqual(h.saved.at(-1), []);
    close(); stop(); assert.equal(h.settingsChanges.size, 0); assert.equal(h.changes.size, 0);
});
