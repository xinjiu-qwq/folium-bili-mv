import { errorText } from './errors.mjs';

// Shared per-activation song bindings and guarded asynchronous search state.
export const MAX_BINDINGS = 300;
export const MAX_BINDING_BYTES = 300_000;
const STORAGE_KEY = 'bindings.v1';
const bv = value => typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export function songKey(song) {
    if (!song) return null;
    if (song.id != null && String(song.id) !== '') return JSON.stringify(['id', song.source ?? '', String(song.id)]);
    const title = normalize(song.title); const artist = normalize(song.artist);
    return title || artist ? JSON.stringify(['meta', title, artist]) : null;
}
function validKey(key) {
    try {
        const parts = JSON.parse(key);
        return key.length <= 2048 && Array.isArray(parts) && parts.length === 3 && ['id', 'meta'].includes(parts[0]) && parts.slice(1).every(p => typeof p === 'string');
    } catch { return false; }
}
export function cleanBinding(value) {
    if (!value || !bv(value.bvid) || !positive(value.cid) || !positive(value.page) || typeof value.title !== 'string' || !Number.isFinite(value.offset) || Math.abs(value.offset) > 3600) return null;
    return { bvid: value.bvid, cid: value.cid, page: value.page, title: value.title.slice(0, 240), offset: value.offset };
}
export function sanitizeBindings(raw) {
    if (!Array.isArray(raw)) return [];
    const map = new Map();
    for (const entry of raw.slice(-2000)) {
        if (!Array.isArray(entry) || !validKey(entry[0])) continue;
        const value = cleanBinding(entry[1]);
        if (value) { map.delete(entry[0]); map.set(entry[0], value); }
    }
    const entries = [...map].slice(-MAX_BINDINGS);
    while (entries.length && new TextEncoder().encode(JSON.stringify(entries)).length > MAX_BINDING_BYTES) entries.shift();
    return entries;
}
export function safeMediaUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 && Number(url.port) <= 65535 && !url.username && !url.password && !url.hash && (url.pathname.length > 1 || url.search.length > 1) ? url.href : null;
    } catch { return null; }
}
export function safeCoverUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)(hdslb\.com|biliimg\.com)$/.test(url.hostname) ? url.href : null;
    } catch { return null; }
}
export function syncTarget(state, offset, duration) {
    const time = state.position + offset;
    if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return { time: 0, playing: false };
    return { time: Math.max(0, Math.min(duration, time)), playing: state.state === 'playing' && time >= 0 && time < duration };
}
export function defaultKeyword(song) { return song ? `${song.title ?? ''} ${song.artist ?? ''} MV`.replace(/\s+/g, ' ').trim().slice(0, 100) : ''; }

export function createModel(folium, account) {
    let data = { song: null, key: null, binding: null, results: [], details: null, busy: false, status: '', retry: 0, authRevision: 0 };
    let bindings = new Map(); let ready; let writable = true; let ended = false;
    let users = 0; let panels = 0; let generation = 0; let searchGeneration = 0; let detailGeneration = 0; let pendingSearchKey = null;
    let writeTail = Promise.resolve(); let unsubscribers = []; const listeners = new Set(); const searched = new Set();
    const emit = () => listeners.forEach(fn => fn());
    const patch = values => { data = { ...data, ...values }; emit(); };
    const isCurrent = (gen, key) => !ended && users > 0 && gen === generation && key === data.key;
    const readSong = () => {
        const song = folium.playback.getState().song; const key = songKey(song);
        if (key === data.key) { data = { ...data, song }; return; }
        generation++; searchGeneration++; detailGeneration++; pendingSearchKey = null;
        patch({ song, key, binding: bindings.get(key) ?? null, results: [], details: null, busy: false, status: '' });
        void autoSearch();
    };
    const ensureReady = () => {
        if (!ready) ready = (async () => {
            try { bindings = new Map(sanitizeBindings(await folium.storage.get(STORAGE_KEY))); }
            catch { writable = false; patch({ status: '绑定读取失败；本次更改不会覆盖已保存数据' }); }
            if (!ended) { patch({ binding: bindings.get(data.key) ?? null }); void autoSearch(); }
        })();
        return ready;
    };
    async function autoSearch() {
        await ensureReady();
        if (ended || !users || !panels || !data.key || data.binding || searched.has(data.key)) return;
        searched.add(data.key);
        // Only keep a bounded session history; never auto-select a result.
        if (searched.size > 300) searched.delete(searched.values().next().value);
        await search(defaultKeyword(data.song));
    }
    async function search(keyword) {
        keyword = String(keyword ?? '').trim().slice(0, 100);
        if (!keyword || !data.key || ended || !users) return;
        const gen = generation; const key = data.key; const request = ++searchGeneration;
        pendingSearchKey = key;
        ++detailGeneration; patch({ busy: true, details: null, status: '正在搜索…' });
        try {
            const raw = await folium.rpc.call('search', keyword);
            if (!isCurrent(gen, key) || request !== searchGeneration) return;
            if (!Array.isArray(raw)) throw Error('bili:invalid-response');
            const results = Array.isArray(raw) ? raw.slice(0, 40).filter(r => r && bv(r.bvid) && typeof r.title === 'string').map(r => ({ bvid: r.bvid, title: r.title.slice(0, 240), author: String(r.author ?? '').slice(0, 120), duration: Number.isFinite(r.duration) ? Math.max(0, r.duration) : 0, cover: safeCoverUrl(r.cover) })) : [];
            patch({ results, busy: false, status: results.length ? `找到 ${results.length} 个视频，请选择` : '未找到视频，请修改关键词重试' });
        } catch (error) { if (isCurrent(gen, key) && request === searchGeneration) patch({ busy: false, status: errorText(error, '搜索') }); }
        finally { if (gen === generation && request === searchGeneration) pendingSearchKey = null; }
    }
    async function select(result) {
        if (!bv(result?.bvid) || ended || !users) return;
        const gen = generation; const key = data.key; const request = ++detailGeneration;
        patch({ busy: true, details: null, status: '正在读取分P…' });
        try {
            const raw = await folium.rpc.call('details', result.bvid);
            if (!isCurrent(gen, key) || request !== detailGeneration) return;
            const pages = Array.isArray(raw?.pages) ? raw.pages.slice(0, 300).filter(p => positive(p?.cid) && positive(p.page) && typeof p.title === 'string').map(p => ({ cid: p.cid, page: p.page, title: p.title.slice(0, 240), duration: Number.isFinite(p.duration) ? p.duration : 0 })) : [];
            if (raw?.bvid !== result.bvid || !pages.length) throw Error('bili:invalid-response');
            patch({ details: { bvid: raw.bvid, title: String(raw.title ?? result.title).slice(0, 240), pages }, busy: false, status: '请选择分P并绑定当前歌曲' });
        } catch (error) { if (isCurrent(gen, key) && request === detailGeneration) patch({ busy: false, status: errorText(error, '分P读取') }); }
    }
    function persist() {
        const entries = sanitizeBindings([...bindings]); bindings = new Map(entries);
        if (!writable) { patch({ status: '无法保存：绑定读取失败，本次仅在内存使用' }); return; }
        writeTail = writeTail.catch(() => {}).then(() => folium.storage.set(STORAGE_KEY, entries)).catch(() => { if (!ended) patch({ status: '绑定保存失败，请重试' }); });
    }
    async function bind(value) {
        const key = data.key; const gen = generation; const cleaned = value == null ? null : cleanBinding(value);
        if (!key || (value != null && !cleaned)) return false;
        await ensureReady(); if (ended) return false;
        bindings.delete(key); if (cleaned) bindings.set(key, cleaned);
        if (gen === generation && key === data.key) patch({ binding: cleaned, status: cleaned ? '已绑定当前歌曲' : '已解除绑定' });
        persist(); return true;
    }
    function authChanged(revision) {
        if (ended || !Number.isSafeInteger(revision) || revision <= data.authRevision) return;
        generation++; searchGeneration++; detailGeneration++; pendingSearchKey = null;
        patch({ authRevision: revision, results: [], details: null, busy: false, status: '账号状态已变化，请点击“重试播放”；搜索和分P需重新选择' });
    }
    function acquire() {
        if (ended) return () => {};
        if (++users === 1) {
            unsubscribers = [folium.events.on('playback.songChanged', readSong), folium.events.on('playback.stateChanged', emit), folium.events.on('playback.seeked', emit)];
            if (account) {
                unsubscribers.push(account.subscribe(() => authChanged(account.get().state.revision)), account.acquire());
                authChanged(account.get().state.revision);
            }
            readSong(); void ensureReady();
        }
        let released = false;
        return () => {
            if (released) return; released = true;
            if (--users === 0) {
                const interruptedSearch = pendingSearchKey !== null;
                if (interruptedSearch) searched.delete(pendingSearchKey);
                pendingSearchKey = null; generation++; searchGeneration++; detailGeneration++;
                unsubscribers.splice(0).forEach(fn => fn());
                data = { ...data, busy: false, ...(interruptedSearch ? { status: '', results: [], details: null } : {}) };
            }
        };
    }
    return {
        get: () => data, get ready() { return ensureReady(); }, acquire,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        openPanel() { panels++; void autoSearch(); let closed = false; return () => { if (!closed) { closed = true; panels--; } }; },
        search, select, bind, authChanged, flush: () => writeTail,
        setOffset(value) { if (!data.binding) return Promise.resolve(false); return bind({ ...data.binding, offset: value }); },
        report(status) { if (!ended) patch({ status }); },
        retry() { patch({ retry: data.retry + 1, status: '正在重试…' }); },
        dispose() { if (ended) return; ended = true; generation++; unsubscribers.splice(0).forEach(fn => fn()); listeners.clear(); },
    };
}
