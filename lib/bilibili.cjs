const { createHash } = require('node:crypto');

// Bounded Bilibili API requests; explicit credentials stay on this origin, with no retries or bypass.
const API = 'https://api.bilibili.com';
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const BV_PATTERN = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
const MIXIN_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

function validateBvid(bvid) {
    if (typeof bvid !== 'string' || !BV_PATTERN.test(bvid)) throw new TypeError('Invalid bvid');
}

function validateCid(cid) {
    if (!Number.isSafeInteger(cid) || cid <= 0) throw new TypeError('Invalid cid');
}

function cleanText(value) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', middot: '·', bull: '•' };
    return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
        if (Object.hasOwn(entities, name.toLowerCase())) return entities[name.toLowerCase()];
        if (name[0] !== '#') return entity;
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
}

function positiveDuration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid media duration');
    return value;
}

function mediaUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && url.hostname.endsWith('.bilivideo.com')) return url.href;
    } catch {}
    throw new Error('Invalid media URL');
}

function createBilibiliClient({ fetchImpl = fetch, getCookie = async () => '' } = {}) {
    const lifetime = new AbortController();
    let signingKey;

    const failures = new WeakMap();
    function failure(kind) {
        const error = new Error(`bili:${kind}`);
        failures.set(error, kind);
        return error;
    }
    function ensureOpen() {
        if (lifetime.signal.aborted) throw failure('stopped');
    }
    const expose = (run) => async (...args) => {
        try { return await run(...args); }
        catch (error) { throw failure(failures.get(error) || 'invalid-response'); }
    };

    // Bound the full request, including credential retrieval and streamed body, and cancel on shutdown.
    async function request(path, params = {}, navMode = '') {
        ensureOpen();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([lifetime.signal, timeout.signal]);
        let reader;
        let body;
        let onAbort;
        const aborted = new Promise((_resolve, reject) => {
            onAbort = () => reject(failure(lifetime.signal.aborted ? 'stopped' : 'timeout'));
            signal.addEventListener('abort', onAbort, { once: true });
        });
        const wait = (promise) => Promise.race([promise, aborted]);
        try {
            const url = new URL(path, API);
            if (url.origin !== API) throw failure('invalid-response');
            url.search = new URLSearchParams(params).toString();
            let cookie;
            try { cookie = await wait(Promise.resolve().then(() => getCookie())); }
            catch (error) {
                if (signal.aborted) throw error;
                throw failure('credential-storage');
            }
            ensureOpen();
            signal.throwIfAborted();
            if (typeof cookie !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(cookie) || Buffer.byteLength(cookie, 'utf8') > 8192) throw failure('credential-storage');
            const response = await wait(fetchImpl(url.href, {
                signal,
                credentials: 'omit',
                redirect: 'error',
                headers: { Accept: 'application/json', Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) },
            }));
            body = response.body;
            signal.throwIfAborted();
            if (!response.ok) {
                throw failure([412, 429].includes(response.status) ? 'risk-control' : response.status === 401 ? 'login-required' : 'unavailable');
            }
            if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) {
                throw failure('invalid-response');
            }
            if (!response.body) throw failure('invalid-response');
            reader = response.body.getReader();
            let size = 0;
            const chunks = [];
            for (;;) {
                const { done, value } = await wait(reader.read());
                signal.throwIfAborted();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_JSON_BYTES) throw failure('invalid-response');
                chunks.push(Buffer.from(value));
            }
            let payload;
            try { payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
            catch { throw failure('invalid-response'); }
            if (!payload || !Number.isSafeInteger(payload.code)) throw failure('invalid-response');
            // Anonymous nav returns -101 but still publishes the ordinary WBI image keys.
            if (navMode === 'account' && payload.code === -101) return { isLogin: false };
            if (payload.code !== 0 && !(navMode === 'wbi' && payload.code === -101 && payload.data?.wbi_img)) {
                throw failure(payload.code === -101 ? 'login-required' : [-352, -412].includes(payload.code) ? 'risk-control' : 'unavailable');
            }
            if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw failure('invalid-response');
            return payload.data;
        } catch (error) {
            throw failure(lifetime.signal.aborted ? 'stopped' : timeout.signal.aborted ? 'timeout' : failures.get(error) || 'network');
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            // Cancellation is best effort and must not prolong timeout/shutdown indefinitely.
            try {
                const cancelled = reader ? reader.cancel() : body?.cancel();
                Promise.resolve(cancelled).catch(() => {});
            } catch {}
            if (reader) { try { reader.releaseLock(); } catch {} }
        }
    }

    async function signedRequest(path, params) {
        if (!signingKey) {
            const data = await request('/x/web-interface/nav', {}, 'wbi');
            const keys = [data.wbi_img?.img_url, data.wbi_img?.sub_url].map((value) => {
                const key = typeof value === 'string' ? value.match(/\/([a-f0-9]{32})\.[a-z]+(?:\?.*)?$/i)?.[1] : null;
                if (!key) throw new Error('Invalid Bilibili WBI keys');
                return key;
            }).join('');
            signingKey = MIXIN_ORDER.map((index) => keys[index]).join('').slice(0, 32);
        }
        ensureOpen();
        const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
        const query = Object.keys(signed).sort().map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(signed[key]).replace(/[!'()*]/g, ''))}`).join('&');
        const w_rid = createHash('md5').update(query + signingKey).digest('hex');
        return request(path, { ...Object.fromEntries(new URLSearchParams(query)), w_rid });
    }

    return {
        account: expose(async () => {
            const data = await request('/x/web-interface/nav', {}, 'account');
            if (data.isLogin === false) return { loggedIn: false, name: '' };
            if (data.isLogin !== true || typeof data.uname !== 'string') throw failure('invalid-response');
            return { loggedIn: true, name: cleanText(data.uname) };
        }),
        search: expose(async (keyword) => {
            ensureOpen();
            if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100) throw new TypeError('Invalid keyword (1–100 characters)');
            const data = await signedRequest('/x/web-interface/wbi/search/type', { keyword: keyword.trim(), search_type: 'video', page: 1, page_size: 20 });
            if (data.is_risk || data.v_voucher) throw failure('risk-control');
            if (!Array.isArray(data.result)) throw failure('invalid-response');
            return data.result.map((item) => {
                validateBvid(item.bvid);
                const parts = typeof item.duration === 'string' && /^\d+(?::\d{1,2}){0,2}$/.test(item.duration) ? item.duration.split(':').map(Number) : [];
                if (!parts.length || parts.slice(1).some((part) => part >= 60)) throw new Error('Invalid search duration');
                const duration = positiveDuration(parts.reduce((seconds, part) => seconds * 60 + part, 0));
                const cover = new URL(item.pic?.startsWith('//') ? `https:${item.pic}` : item.pic);
                if (cover.protocol !== 'https:' || cover.username || cover.password) throw new Error('Invalid search cover');
                return { bvid: item.bvid, title: cleanText(item.title), author: cleanText(item.author), duration, cover: cover.href };
            });
        }),
        details: expose(async (bvid) => {
            ensureOpen();
            validateBvid(bvid);
            const data = await request('/x/web-interface/view', { bvid });
            if (data.bvid !== bvid || !Array.isArray(data.pages) || !data.pages.length) throw new Error('Invalid Bilibili metadata bvid/pages');
            const pages = data.pages.map((item) => {
                validateCid(item.cid);
                if (!Number.isSafeInteger(item.page) || item.page <= 0) throw new Error('Invalid metadata page');
                return { cid: item.cid, page: item.page, title: cleanText(item.part), duration: positiveDuration(item.duration) };
            });
            return { bvid, title: cleanText(data.title), pages };
        }),
        resolve: expose(async (input) => {
            ensureOpen();
            if (!input || typeof input !== 'object') throw new TypeError('Invalid resolve input');
            const { bvid, cid } = input;
            validateBvid(bvid);
            validateCid(cid);
            const data = await signedRequest('/x/player/wbi/playurl', { bvid, cid, qn: 64, fnval: 16, fnver: 0, fourk: 0 });
            const videos = Array.isArray(data.dash?.video) ? data.dash.video : [];
            const avc = videos.filter((track) => track.codecid === 7 && (!track.codecs || /^avc1\./i.test(track.codecs)) && (!track.mimeType || track.mimeType === 'video/mp4'))
                .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
            for (const track of avc) {
                try {
                    return { url: mediaUrl(track.baseUrl || track.base_url), duration: positiveDuration(data.dash.duration || data.timelength / 1000) };
                } catch {}
            }
            if (Array.isArray(data.durl) && data.durl.length === 1 && (data.format === 'mp4' || /^mp4\b/i.test(data.format || '')) && (!data.video_codecid || data.video_codecid === 7)) {
                return { url: mediaUrl(data.durl[0].url), duration: positiveDuration((data.timelength || data.durl[0].length) / 1000) };
            }
            throw failure('unsupported-media');
        }),
        close() {
            lifetime.abort();
            signingKey = undefined;
        },
    };
}

module.exports = { createBilibiliClient };
