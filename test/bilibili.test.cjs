const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createBilibiliClient } = require('../lib/bilibili.cjs');

// Public API contracts, using bounded in-memory HTTP responses rather than the live service.
const BV = 'BV17x411w7KC';
const media = 'https://upos-sz-mirrorcos.bilivideo.com/video.mp4';
const nav = { code: -101, data: { wbi_img: {
    img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
} } };
const json = (value, init) => new Response(JSON.stringify(value), init);
function fixture(data, inspect = () => {}) {
    const calls = [];
    const client = createBilibiliClient({ fetchImpl: async (url, options) => {
        calls.push(new URL(url));
        inspect(new URL(url), options);
        return json(String(url).includes('/nav') ? nav : { code: 0, data });
    } });
    return { client, calls };
}

test('search normalizes markup/entities, seconds, cover and sends conventional WBI signature without cookies', async () => {
    const { client, calls } = fixture({ result: [{ bvid: BV, title: '<em class="keyword">A</em> &amp; &#x4e2d; &quot;B&quot;', author: 'A&nbsp;B', duration: '1:02:03', pic: '//i0.hdslb.com/a.jpg' }] }, (url, options) => {
        assert.equal(options.credentials, 'omit');
        assert.equal(new Headers(options.headers).has('cookie'), false);
        assert.ok(options.signal instanceof AbortSignal);
        if (!url.pathname.includes('/nav')) {
            assert.equal(url.pathname, '/x/web-interface/wbi/search/type');
            const signature = url.searchParams.get('w_rid');
            const params = new URLSearchParams(url.search);
            params.delete('w_rid');
            params.sort();
            assert.equal(signature, createHash('md5').update(params.toString() + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
        }
    });
    assert.deepEqual(await client.search('音乐'), [{ bvid: BV, title: 'A & 中 "B"', author: 'A B', duration: 3723, cover: 'https://i0.hdslb.com/a.jpg' }]);
    await client.search('another');
    assert.equal(calls.filter((url) => url.pathname.endsWith('/nav')).length, 1);
    client.close();
});

test('empty successful search is distinguishable from platform failure', async () => {
    const { client } = fixture({ result: [] });
    assert.deepEqual(await client.search('missing'), []);
    client.close();
});

test('search keyword and BV/CID inputs reject before network access', async () => {
    let calls = 0;
    const client = createBilibiliClient({ fetchImpl: async () => { calls++; throw Error('unexpected'); } });
    for (const keyword of ['', '  ', 'a'.repeat(101), null, {}, 1]) await assert.rejects(client.search(keyword), /^Error: bili:invalid-response$/);
    for (const bvid of ['av123', 'BV0000000000', BV + '/', 'bv17x411w7KC', null]) await assert.rejects(client.details(bvid), /^Error: bili:invalid-response$/);
    for (const cid of [0, -1, 1.1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(client.resolve({ bvid: BV, cid }), /^Error: bili:invalid-response$/);
    await assert.rejects(client.resolve(null), /^Error: bili:invalid-response$/);
    assert.equal(calls, 0);
    client.close();
});

test('details returns all validated pages', async () => {
    const { client } = fixture({ bvid: BV, title: 'A &amp; B', pages: [{ cid: 123, page: 1, part: 'Part &lt;1&gt;', duration: 42 }] });
    assert.deepEqual(await client.details(BV), { bvid: BV, title: 'A & B', pages: [{ cid: 123, page: 1, title: 'Part <1>', duration: 42 }] });
    client.close();
});

for (const data of [{ bvid: 'BV1Q541167Qg', pages: [] }, { bvid: BV, pages: [{ cid: '1', page: 1, duration: 1 }] }, { bvid: BV, pages: [] }]) {
    test('details rejects malformed or mismatched upstream metadata ' + JSON.stringify(data), async () => {
        const { client } = fixture(data);
        await assert.rejects(client.details(BV), /^Error: bili:invalid-response$/);
        client.close();
    });
}

test('resolve prefers an AVC DASH video track, not HEVC, AV1 or audio', async () => {
    const { client } = fixture({ timelength: 42000, dash: { duration: 42, video: [
        { codecid: 12, codecs: 'hev1.1', baseUrl: media + '?hevc' },
        { codecid: 7, codecs: 'avc1.64001f', mimeType: 'video/mp4', bandwidth: 200, baseUrl: media },
    ], audio: [{ baseUrl: media + '?audio' }] }, durl: [{ url: media + '?fallback' }] });
    assert.deepEqual(await client.resolve({ bvid: BV, cid: 123 }), { url: media, duration: 42 });
    client.close();
});

test('resolve falls back to a single MP4 durl', async () => {
    const { client } = fixture({ timelength: 12500, format: 'mp4', durl: [{ url: media, length: 12500 }] });
    assert.deepEqual(await client.resolve({ bvid: BV, cid: 123 }), { url: media, duration: 12.5 });
    client.close();
});

for (const data of [
    { timelength: 1000, format: 'mp4', durl: [{ url: media }, { url: media }] },
    { dash: { duration: 1, video: [{ codecid: 12, baseUrl: media }] } },
    { timelength: 1000, format: 'flv', durl: [{ url: media + '.flv' }] },
    { dash: { duration: 1, video: [{ codecid: 7, baseUrl: 'http://127.0.0.1/private' }] } },
    { dash: { duration: 1, video: [{ codecid: 7, baseUrl: 'https://bilivideo.com.attacker.test/a' }] } },
    { dash: { duration: 0, video: [{ codecid: 7, baseUrl: media }] } },
]) {
    test('resolve rejects unavailable/unsafe media ' + JSON.stringify(data), async () => {
        const { client } = fixture(data);
        await assert.rejects(client.resolve({ bvid: BV, cid: 123 }), /AVC|media|duration|MP4/i);
        client.close();
    });
}

for (const code of [-352, -412, -101, -404]) {
    test('platform code ' + code + ' is surfaced, never an empty search', async () => {
        const client = createBilibiliClient({ fetchImpl: async (url) => json(String(url).includes('/nav') ? nav : { code, message: '访问受限' }) });
        await assert.rejects(client.search('music'), { message: `bili:${code === -101 ? 'login-required' : [-352, -412].includes(code) ? 'risk-control' : 'unavailable'}` });
        client.close();
    });
}

for (const [label, response, pattern] of [
    ['HTTP', () => new Response('blocked', { status: 412 }), /^Error: bili:risk-control$/],
    ['invalid JSON', () => new Response('<html>blocked</html>'), /^Error: bili:invalid-response$/],
    ['large declared JSON', () => new Response('{}', { headers: { 'content-length': '2097152' } }), /^Error: bili:invalid-response$/],
    ['large streamed JSON', () => new Response(' '.repeat(1048577)), /^Error: bili:invalid-response$/],
    ['missing data', () => json({ code: 0 }), /data|response/i],
]) {
    test('request rejects ' + label, async () => {
        const client = createBilibiliClient({ fetchImpl: async () => response() });
        await assert.rejects(client.details(BV), pattern);
        client.close();
    });
}

test('closing aborts in-flight fetch and forbids future calls', async () => {
    let signal;
    const entered = deferred();
    const client = createBilibiliClient({ fetchImpl: (_url, options) => {
        signal = options.signal;
        entered.resolve();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    const pending = client.details(BV);
    await entered.promise;
    client.close();
    await assert.rejects(pending, /closed|stopped|abort/i);
    assert.equal(signal.aborted, true);
    await assert.rejects(client.details(BV), /closed|stopped/i);
});

test('search explicitly reports successful-code risk-control placeholders', async () => {
    const { client } = fixture({ v_voucher: 'do-not-use', is_risk: true });
    await assert.rejects(client.search('music'), /^Error: bili:risk-control$/);
    client.close();
});

test('WBI signature is correct for spaces and filtered punctuation', async () => {
    const { client } = fixture({ result: [] }, (url) => {
        if (url.pathname.includes('/search/')) {
            const params = [...url.searchParams.entries()].filter(([key]) => key !== 'w_rid').sort(([a], [b]) => a.localeCompare(b));
            const query = params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
            assert.equal(url.searchParams.get('w_rid'), createHash('md5').update(query + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
        }
    });
    assert.deepEqual(await client.search("music MV!'()*"), []);
    client.close();
});

test('search decodes common title typography entities', async () => {
    const { client } = fixture({ result: [{ bvid: BV, title: '&ldquo;MV&rdquo; &ndash; &hellip; &copy;', author: 'UP', duration: '1:00', pic: '//i0.hdslb.com/a.jpg' }] });
    assert.equal((await client.search('music'))[0].title, '“MV” – … ©');
    client.close();
});

const deferred = () => {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    return { promise, resolve };
};

for (const [payload, expected] of [
    [{ code: -101 }, { loggedIn: false, name: '' }],
    [{ code: -101, data: nav.data }, { loggedIn: false, name: '' }],
    [{ code: 0, data: { isLogin: false, uname: 'not logged in' } }, { loggedIn: false, name: '' }],
    [{ code: 0, data: { isLogin: true, uname: 'Test user' } }, { loggedIn: true, name: 'Test user' }],
]) {
    test('account identifies nav state ' + JSON.stringify(payload), async () => {
        const client = createBilibiliClient({ getCookie: async () => 'SESSDATA=secret', fetchImpl: async (url, options) => {
            assert.equal(new URL(url).origin, 'https://api.bilibili.com');
            assert.equal(new URL(url).pathname, '/x/web-interface/nav');
            assert.equal(new Headers(options.headers).get('cookie'), 'SESSDATA=secret');
            assert.equal(options.redirect, 'error');
            assert.equal(options.credentials, 'omit');
            return json(payload);
        } });
        assert.deepEqual(await client.account(), expected);
        client.close();
    });
}

test('all API calls obtain current explicit Cookie only for fixed API origin', async () => {
    let count = 0;
    const client = createBilibiliClient({ getCookie: async () => `SESSDATA=${++count}`, fetchImpl: async (url, options) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://api.bilibili.com');
        assert.equal(new Headers(options.headers).get('cookie'), `SESSDATA=${count}`);
        return json(parsed.pathname.endsWith('/nav') ? nav : { code: 0, data: { result: [] } });
    } });
    await client.search('mv');
    await client.search('again');
    assert.equal(count, 3);
    client.close();
});

for (const cookie of ['x=secret\r\nInjected: yes', 'x=\x00secret', 'x=\x7f', 'x=\x85', 'x'.repeat(8193), '中'.repeat(3000), null, {}]) {
    test('unsafe credential never reaches fetch ' + String(cookie).length, async () => {
        let calls = 0;
        const client = createBilibiliClient({ getCookie: async () => cookie, fetchImpl: async () => { calls++; return json(nav); } });
        await assert.rejects(client.details(BV), { message: 'bili:credential-storage' });
        assert.equal(calls, 0);
        client.close();
    });
}

test('8KB credential is accepted without implicit credential forwarding', async () => {
    const client = createBilibiliClient({ getCookie: async () => 'x'.repeat(8192), fetchImpl: async (_url, options) => {
        assert.equal(new Headers(options.headers).get('cookie').length, 8192);
        return json({ code: -101 });
    } });
    assert.deepEqual(await client.account(), { loggedIn: false, name: '' });
    client.close();
});

for (const [source, expected] of [['storage', 'credential-storage'], ['fetch', 'network'], ['body', 'network'], ['api', 'unavailable']]) {
    test('redacts original message, cookie and cause from ' + source, async () => {
        const secret = 'SESSDATA=must-never-escape';
        const original = new Error(secret, { cause: new Error(secret) });
        const client = createBilibiliClient({ getCookie: async () => { if (source === 'storage') throw original; return secret; }, fetchImpl: async () => {
            if (source === 'fetch') throw original;
            if (source === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(original); } }));
            return json({ code: -400, message: secret, msg: secret });
        } });
        await assert.rejects(client.details(BV), (error) => {
            assert.equal(error.message, `bili:${expected}`);
            assert.equal(error.cause, undefined);
            assert.equal(String(error.stack).includes(secret), false);
            return true;
        });
        client.close();
    });
}

test('closing during asynchronous credential retrieval prevents fetch', async () => {
    const cookie = deferred();
    let calls = 0;
    const client = createBilibiliClient({ getCookie: () => cookie.promise, fetchImpl: async () => { calls++; return json(nav); } });
    const pending = client.details(BV);
    client.close();
    cookie.resolve('SESSDATA=secret');
    await assert.rejects(pending, { message: 'bili:stopped' });
    assert.equal(calls, 0);
});

test('credential timeout is sanitized, clears its timer and prevents late fetch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cookie = deferred();
    let calls = 0;
    const client = createBilibiliClient({ getCookie: () => cookie.promise, fetchImpl: async () => { calls++; return json(nav); } });
    const pending = client.details(BV);
    t.mock.timers.tick(10001);
    await assert.rejects(pending, { message: 'bili:timeout' });
    cookie.resolve('SESSDATA=secret');
    await Promise.resolve();
    assert.equal(calls, 0);
    client.close();
});

test('request timeout also covers stalled JSON body', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred();
    const client = createBilibiliClient({ fetchImpl: async (_url, options) => new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
        entered.resolve();
    } })) });
    const pending = client.details(BV);
    await entered.promise;
    t.mock.timers.tick(10001);
    await assert.rejects(pending, /timeout/i);
    client.close();
});
