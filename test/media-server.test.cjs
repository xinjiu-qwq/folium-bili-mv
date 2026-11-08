'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns').promises;
const { once } = require('node:events');
const { test } = require('node:test');
const { createMediaServer } = require('../lib/media-server.cjs');

// Offline integration tests: only the injected validator may authorize loopback upstreams.
const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

async function fixture(t, handler, options = {}) {
    const calls = [];
    const upstream = http.createServer((req, res) => {
        calls.push({ url: req.url, method: req.method, headers: req.headers });
        if (handler) return handler(req, res);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Set-Cookie', 'secret=upstream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Location', 'https://secret.invalid/signed');
        const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (req.headers.range === 'bytes=999-') {
            res.writeHead(416, { 'Content-Range': `bytes */${CONTENT.length}` });
            return res.end();
        }
        const body = match ? CONTENT.subarray(Number(match[1]), Number(match[2]) + 1) : CONTENT;
        res.statusCode = match ? 206 : 200;
        if (match) res.setHeader('Content-Range', `bytes ${match[1]}-${match[2]}/${CONTENT.length}`);
        res.setHeader('Content-Length', body.length);
        res.end(req.method === 'HEAD' ? undefined : body);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const proxy = await createMediaServer({
        validateUrl: (value) => new URL(value).origin === base,
        ...options,
    });
    t.after(async () => {
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
    });
    return { proxy, calls, base, issue: (path = '/video', ttl) => proxy.issue(`${base}${path}`, ttl) };
}

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'condition did not become true');
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test('issues opaque loopback capabilities and streams only safe response headers', async (t) => {
    const { proxy, calls, issue } = await fixture(t);
    const local = issue('/video?signature=never-leak');
    assert.equal(typeof local, 'string');
    assert.match(local, /^http:\/\/127\.0\.0\.1:\d+\/media\/[A-Za-z0-9_-]{43}$/);
    assert.notEqual(local, issue());
    assert.ok(!local.includes('signature'));
    const result = await request(local);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, CONTENT);
    assert.equal(result.headers['content-type'], 'video/mp4');
    assert.equal(result.headers['content-length'], String(CONTENT.length));
    assert.equal(result.headers['accept-ranges'], 'bytes');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    for (const header of ['set-cookie', 'location', 'access-control-allow-origin']) {
        assert.equal(result.headers[header], undefined);
    }
    assert.equal(calls.length, 1);
    proxy.revoke(local);
    assert.equal((await request(local)).status, 404);
});

test('forwards a single Range and preserves 206, 416 and HEAD semantics', async (t) => {
    const { issue, calls } = await fixture(t);
    const local = issue();
    const partial = await request(local, { headers: { Range: 'bytes=3-8', Cookie: 'secret', Authorization: 'secret' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.body.toString(), '345678');
    assert.equal(partial.headers['content-range'], `bytes 3-8/${CONTENT.length}`);
    assert.equal(calls[0].headers.range, 'bytes=3-8');
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(calls[0].headers.authorization, undefined);
    const unsatisfiable = await request(local, { headers: { Range: 'bytes=999-' } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers['content-range'], `bytes */${CONTENT.length}`);
    const head = await request(local, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(CONTENT.length));
    assert.equal(calls[2].method, 'HEAD');
    for (const range of ['bytes=0-1,3-4', 'bytes=-0', 'bytes=9-2', 'items=0-1', 'bytes=9007199254740992-', 'bytes= 0-1', 'bytes=-']) {
        assert.equal((await request(local, { headers: { Range: range } })).status, 416, range);
    }
    assert.equal(calls.length, 3);
    for (const range of ['bytes=0-', 'bytes=-5']) {
        assert.equal((await request(local, { headers: { Range: range } })).status, 200);
    }
});

test('invalid token, open proxy URLs, methods, foreign Host and cross-site fetch never reach upstream', async (t) => {
    const { issue, calls, base } = await fixture(t);
    const local = issue();
    const origin = new URL(local).origin;
    for (const path of ['/media/invalid', `/?url=${encodeURIComponent(`${base}/video`)}`, `${new URL(local).pathname}?url=${base}`, '/favicon.ico']) {
        assert.equal((await request(`${origin}${path}`)).status, 404);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']) {
        assert.equal((await request(local, { method })).status, 405);
    }
    assert.equal((await request(local, { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await request(local, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(local, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'no-cors' } })).status, 403);
    assert.equal(calls.length, 0);
});

test('permits Electron file video and dev localhost media without CORS', async (t) => {
    const { issue } = await fixture(t);
    for (const headers of [
        { Origin: 'null' },
        { Origin: 'http://localhost:5173' },
        { Origin: 'http://127.0.0.1:5173' },
        { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'video', 'Sec-Fetch-Mode': 'no-cors' },
    ]) {
        const result = await request(issue(), { headers });
        assert.equal(result.status, 200);
        assert.equal(result.headers['access-control-allow-origin'], undefined);
    }
});

test('default whitelist rejects non-CDN URLs before issuing capabilities', async (t) => {
    const proxy = await createMediaServer();
    t.after(() => proxy.close());
    for (const url of [
        'http://a.bilivideo.com/v', 'https://127.0.0.1/v', 'https://[::1]/v',
        'https://a.bilivideo.com:444/v', 'https://a.bilivideo.com:443/v',
        'https://user:pass@a.bilivideo.com/v', 'https://a.bilivideo.com/v#x',
        'https://a.bilivideo.com/v#', 'https://a.bilivideo.com.evil.example/v',
        'https://a.akamaized.net/v', 'https://evil.example/v', 'https://a.bilivideo.com./v',
        'https://a.bilivideo.com\\@evil.example/v',
    ]) assert.throws(() => proxy.issue(url), /URL|upstream|CDN|port|host|HTTPS|fragment|credentials/i, url);
    for (const suffix of ['com', 'cn', 'net']) {
        assert.equal(typeof proxy.issue(`https://a.bilivideo.${suffix}/video?sign=secret`), 'string');
    }
});

test('default DNS validation rejects every non-public answer before fetch', async (t) => {
    let addresses = [];
    let fetches = 0;
    t.mock.method(dns, 'lookup', async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    const proxy = await createMediaServer({ fetchImpl: async () => { fetches++; throw new Error('must not fetch'); } });
    t.after(() => proxy.close());
    const local = proxy.issue('https://media.bilivideo.com/video');
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
        addresses = ['8.8.8.8', address];
        assert.equal((await request(local)).status, 502, address);
    }
    addresses = [];
    assert.equal((await request(local)).status, 502);
    assert.equal(fetches, 0);
});

test('redirects are followed manually and revalidated without exposing Location', async (t) => {
    const { issue, calls } = await fixture(t, (req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { Location: '/video' });
            return res.end();
        }
        if (req.url === '/blocked') {
            res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
            return res.end();
        }
        if (req.url === '/loop') {
            res.writeHead(302, { Location: '/loop' });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(CONTENT);
    });
    assert.deepEqual((await request(issue('/start'))).body, CONTENT);
    assert.equal((await request(issue('/blocked'))).status, 502);
    assert.equal(calls.filter((call) => call.url.includes('meta-data')).length, 0);
    const loop = await request(issue('/loop'));
    assert.equal(loop.status, 502);
    assert.ok(calls.length < 12);
    assert.equal(loop.headers.location, undefined);
});

test('default DNS validation rechecks a whitelisted redirect destination', async (t) => {
    let fetches = 0;
    const hosts = [];
    t.mock.method(dns, 'lookup', async (hostname) => {
        hosts.push(hostname);
        return [{ address: hostname === 'first.bilivideo.com' ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    });
    const proxy = await createMediaServer({ fetchImpl: async (_url, options) => {
        fetches++;
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: 'https://second.bilivideo.com/video' } });
    } });
    t.after(() => proxy.close());
    assert.equal((await request(proxy.issue('https://first.bilivideo.com/start'))).status, 502);
    assert.equal(fetches, 1);
    assert.deepEqual(hosts, ['first.bilivideo.com', 'second.bilivideo.com']);
});

test('default validation rejects raw forbidden redirect syntax before URL normalization', async (t) => {
    t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
    let fetches = 0;
    let location;
    const proxy = await createMediaServer({ fetchImpl: async (_url, options) => {
        fetches++;
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: location } });
    } });
    t.after(() => proxy.close());
    for (location of ['https://media.bilivideo.com:443/video', '//media.bilivideo.com:443/video', 'https://@media.bilivideo.com/video']) {
        fetches = 0;
        const result = await request(proxy.issue('https://media.bilivideo.com/start'));
        assert.equal(result.status, 502);
        assert.equal(fetches, 1, location);
    }
});

test('revocation aborts an already active upstream', async (t) => {
    let disconnected = false;
    const { issue, proxy } = await fixture(t, (_req, res) => {
        res.on('close', () => { disconnected = true; });
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write('chunk');
    });
    const local = issue();
    const client = http.get(local);
    client.on('error', () => {});
    const [response] = await once(client, 'response');
    response.on('error', () => {});
    response.resume();
    proxy.revoke(local);
    await until(() => disconnected && response.destroyed);
    assert.equal((await request(local)).status, 404);
    client.destroy();
});

test('close stops requests waiting for upstream response headers', async (t) => {
    let started = false;
    let disconnected = false;
    const { issue, proxy } = await fixture(t, (_req, res) => {
        started = true;
        res.on('close', () => { disconnected = true; });
    });
    const pending = request(issue());
    const failed = assert.rejects(pending);
    await until(() => started);
    await proxy.close();
    await failed;
    await until(() => disconnected);
});

test('expired/revoked capabilities and bounded TTL/token count', async (t) => {
    const { issue, proxy, calls } = await fixture(t);
    const realNow = Date.now;
    let now = realNow();
    t.mock.method(Date, 'now', () => now);
    const expired = issue('/video', 10);
    now += 11;
    assert.ok([404, 410].includes((await request(expired)).status));
    assert.equal(calls.length, 0);
    for (const ttl of [0, -1, NaN, Infinity, 30 * 60 * 1000 + 1]) assert.throws(() => issue('/video', ttl));
    const urls = [];
    for (let i = 0; i < 128; i++) urls.push(issue());
    assert.throws(() => issue(), /limit|capacity|tokens/i);
    proxy.revoke(urls.pop());
    assert.equal(typeof issue(), 'string');
    await proxy.close();
    assert.throws(() => issue(), /closed/i);
    await proxy.close();
});

test('bad upstream types and redirects cannot be rendered as local HTML', async (t) => {
    const { issue } = await fixture(t, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<script>bad()</script>');
    });
    const result = await request(issue());
    assert.equal(result.status, 502);
    assert.ok(!result.body.toString().includes('<script>'));
});

test('streams first chunk before upstream completes and aborts on client disconnect', async (t) => {
    let disconnected = false;
    const { issue } = await fixture(t, (_req, res) => {
        res.on('close', () => { disconnected = true; });
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write('first-chunk');
    });
    await new Promise((resolve, reject) => {
        const req = http.get(issue(), (res) => {
            res.once('data', (chunk) => {
                assert.equal(chunk.toString(), 'first-chunk');
                res.destroy();
                resolve();
            });
            res.on('error', () => {});
        });
        req.on('error', reject);
    });
    await until(() => disconnected);
});

test('concurrency is bounded and close aborts all upstreams plus local sockets', async (t) => {
    let opened = 0;
    let disconnected = 0;
    const { issue, proxy } = await fixture(t, (_req, res) => {
        opened++;
        res.on('close', () => { disconnected++; });
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write('chunk');
    });
    const clients = [];
    const responses = [];
    for (let i = 0; i < 8; i++) {
        const client = http.get(issue());
        client.on('error', () => {});
        const [response] = await once(client, 'response');
        response.on('error', () => {});
        response.resume();
        clients.push(client);
        responses.push(response);
    }
    assert.equal(opened, 8);
    assert.equal((await request(issue())).status, 503);
    await proxy.close();
    await until(() => disconnected === 8 && responses.every((response) => response.destroyed));
    for (const client of clients) client.destroy();
    assert.equal(opened, 8);
});

test('header timeout aborts a stalled upstream and returns 504', async (t) => {
    let started = false;
    let disconnected = false;
    const { issue } = await fixture(t, (_req, res) => {
        started = true;
        res.on('close', () => { disconnected = true; });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = request(issue());
    await until(() => started);
    t.mock.timers.tick(15_001);
    assert.equal((await pending).status, 504);
    await until(() => disconnected);
});

test('body idle timeout aborts a stalled streaming response', async (t) => {
    let disconnected = false;
    const { issue } = await fixture(t, (_req, res) => {
        res.on('close', () => { disconnected = true; });
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write('chunk');
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const client = http.get(issue());
    client.on('error', () => {});
    const [response] = await once(client, 'response');
    response.on('error', () => {});
    response.resume();
    t.mock.timers.tick(30_001);
    await until(() => disconnected && response.destroyed);
    client.destroy();
});
