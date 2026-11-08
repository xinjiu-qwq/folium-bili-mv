'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const { isIP } = require('node:net');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Loopback capability server: signed CDN URLs never leave the trusted main process.
const DEFAULT_TTL = 20 * 60 * 1000;
const MAX_TTL = 30 * 60 * 1000;
const MAX_TOKENS = 128;
const MAX_ACTIVE = 8;
const HEADER_TIMEOUT = 15_000;
const IDLE_TIMEOUT = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const MEDIA_TYPE = /^(?:video\/(?:mp4|webm)|audio\/(?:mp4|mpeg|aac)|application\/octet-stream)(?:\s*;[^\r\n]*)?$/i;

function strictUrl(value) {
    if (typeof value !== 'string' || /[\s\\#]/.test(value)) throw new Error('Invalid upstream URL');
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (url.protocol !== 'https:' || !authority || authority.includes(':') || authority.includes('@') ||
        url.username || url.password || url.hash || url.port || isIP(url.hostname) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+bilivideo\.(?:com|cn|net)$/i.test(url.hostname)) {
        throw new Error('Upstream URL must use an approved HTTPS CDN without port or credentials');
    }
    return true;
}

// IPv6 is conservatively limited to ordinary global unicast; transition/tunnel ranges are excluded.
function publicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113));
    }
    if (isIP(address) !== 6) return false;
    const groups = address.toLowerCase().split(':');
    const first = parseInt(groups[0], 16);
    const second = parseInt(groups[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
        !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
        !(first === 0x3fff && second <= 0xfff);
}

async function checkedAddresses(url) {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
        throw new Error('Unsafe upstream DNS answer');
    }
    return addresses;
}

// Pin TLS sockets to the exact checked address, preserving hostname/SNI and certificate verification.
function pinnedFetch(url, options, addresses) {
    return new Promise((resolve, reject) => {
        const address = addresses[0];
        const req = https.request(url, {
            method: options.method,
            headers: options.headers,
            signal: options.signal,
            agent: false,
            lookup: (_hostname, lookupOptions, callback) => {
                if (lookupOptions.all) callback(null, [address]);
                else callback(null, address.address, address.family);
            },
        }, (res) => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
            // Do not buffer or decompress media. IncomingMessage feeds the downstream with backpressure.
            resolve({ status: res.statusCode, headers, body: res });
        });
        req.on('error', reject);
        req.end();
    });
}

function cancelBody(response) {
    if (!response?.body) return;
    if (typeof response.body.destroy === 'function') response.body.destroy();
    else if (!response.body.locked) void response.body.cancel().catch(() => {});
}

function validRange(value) {
    if (value === undefined) return true;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) return false;
    const start = match[1] ? Number(match[1]) : null;
    const end = match[2] ? Number(match[2]) : null;
    if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))) return false;
    return start === null ? end > 0 : end === null || start <= end;
}

function trustedOrigin(value) {
    if (value === 'null') return true; // Electron file: documents serialize their origin as null.
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
            url.origin === value;
    } catch {
        return false;
    }
}

function permittedClient(req) {
    if (req.headers.origin && !trustedOrigin(req.headers.origin)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') {
        return ['video', 'audio'].includes(req.headers['sec-fetch-dest']) && req.headers['sec-fetch-mode'] === 'no-cors';
    }
    return true;
}

async function createMediaServer({ fetchImpl = fetch, validateUrl = strictUrl } = {}) {
    if (typeof fetchImpl !== 'function' || typeof validateUrl !== 'function') throw new TypeError('Invalid media server options');
    const tokens = new Map();
    const active = new Set();
    const sockets = new Set();
    const tasks = new Set();
    let closed = false;
    let closing;
    let origin;
    let host;

    function prune() {
        const now = Date.now();
        for (const [token, entry] of tokens) if (entry.expires <= now) tokens.delete(token);
    }

    function reply(res, status) {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) return res.destroy();
        res.writeHead(status, {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': '0',
            'X-Content-Type-Options': 'nosniff',
            ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
        });
        res.end();
    }

    async function handle(req, res) {
        // Authenticate before any validation hook, DNS lookup or upstream request can run.
        if (closed) return reply(res, 503);
        if (req.headers.host !== host) return reply(res, 403);
        if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405);
        if (!permittedClient(req)) return reply(res, 403);
        const token = /^\/media\/([A-Za-z0-9_-]{43})$/.exec(req.url)?.[1];
        const entry = token && tokens.get(token);
        if (!entry) return reply(res, 404);
        if (entry.expires <= Date.now()) {
            tokens.delete(token);
            return reply(res, 410);
        }
        if (!validRange(req.headers.range)) return reply(res, 416);
        if (active.size >= MAX_ACTIVE) return reply(res, 503);

        const controller = new AbortController();
        const operation = { controller, token };
        active.add(operation);
        let response;
        let timer;
        let timedOut = false;
        const stop = () => controller.abort();
        const arm = (ms) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, ms);
            timer.unref?.();
        };
        const aborted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('Upstream cancelled')), { once: true });
        });
        // Every pending async operation is raced with abort, including slow DNS or injected fetches.
        const wait = (promise) => Promise.race([promise, aborted]);
        req.once('aborted', stop);
        res.once('close', stop);
        arm(HEADER_TIMEOUT);
        try {
            let url = new URL(entry.url);
            for (let hop = 0; ; hop++) {
                if (await wait(Promise.resolve(validateUrl(url.href))) === false) throw new Error('Rejected upstream URL');
                const addresses = validateUrl === strictUrl ? await wait(checkedAddresses(url)) : null;
                const options = {
                    method: req.method,
                    headers: {
                        Accept: 'video/mp4, video/webm, audio/mp4, application/octet-stream',
                        'Accept-Encoding': 'identity',
                        Referer: 'https://www.bilibili.com/',
                        'User-Agent': 'Mozilla/5.0',
                        ...(req.headers.range ? { Range: req.headers.range } : {}),
                    },
                    redirect: 'manual',
                    signal: controller.signal,
                };
                const pending = fetchImpl === globalThis.fetch && addresses ?
                    pinnedFetch(url, options, addresses) : Promise.resolve(fetchImpl(url.href, options));
                // Also dispose a late result from a custom fetch that ignored the abort signal.
                pending.then((result) => { if (controller.signal.aborted) cancelBody(result); }, () => {});
                response = await wait(pending);
                if (!REDIRECTS.has(response.status)) break;
                const location = response.headers.get('location');
                cancelBody(response);
                response = undefined;
                if (!location || hop >= MAX_REDIRECTS) throw new Error('Rejected upstream redirect');
                if (validateUrl === strictUrl) {
                    // WHATWG URL erases explicit :443 and empty userinfo; inspect authority first.
                    const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(location)?.[1];
                    if (/[\s\\#]/.test(location) || (authority !== undefined && /[:@]/.test(authority))) {
                        throw new Error('Rejected upstream redirect URL');
                    }
                }
                url = new URL(location, url);
            }
            if (![200, 206, 416].includes(response.status)) throw new Error('Rejected upstream status');
            const type = response.headers.get('content-type');
            if (response.status !== 416 && (!type || !MEDIA_TYPE.test(type))) throw new Error('Rejected upstream media type');
            if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
                throw new Error('Encoded media is not supported');
            }
            const headers = {
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': "default-src 'none'; sandbox",
            };
            for (const name of SAFE_HEADERS) {
                const value = response.headers.get(name);
                if (value && !/[\r\n]/.test(value)) headers[name] = value;
            }
            if (headers['content-length'] && !/^\d+$/.test(headers['content-length'])) throw new Error('Invalid upstream length');
            if (headers['accept-ranges'] && !/^(?:bytes|none)$/.test(headers['accept-ranges'])) delete headers['accept-ranges'];
            if (response.status === 206 && !/^bytes \d+-\d+\/\d+$/.test(headers['content-range'] || '')) {
                throw new Error('Invalid upstream range');
            }
            if (response.status === 416) {
                if (headers['content-range'] && !/^bytes \*\/\d+$/.test(headers['content-range'])) delete headers['content-range'];
                delete headers['content-type'];
                headers['content-length'] = '0';
            }
            res.writeHead(response.status, headers);
            if (req.method === 'HEAD' || response.status === 416 || !response.body) {
                cancelBody(response);
                res.end();
            } else {
                const body = typeof response.body.pipe === 'function' ? response.body : Readable.fromWeb(response.body);
                arm(IDLE_TIMEOUT);
                body.on('data', () => arm(IDLE_TIMEOUT));
                await pipeline(body, res, { signal: controller.signal });
            }
        } catch {
            reply(res, timedOut ? 504 : 502); // Deliberately never log signed URLs or upstream errors.
        } finally {
            clearTimeout(timer);
            req.off('aborted', stop);
            res.off('close', stop);
            controller.abort();
            cancelBody(response);
            active.delete(operation);
        }
    }

    const server = http.createServer((req, res) => {
        const task = handle(req, res);
        tasks.add(task);
        task.finally(() => tasks.delete(task)).catch(() => res.destroy());
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 32;
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    host = `127.0.0.1:${server.address().port}`;
    origin = `http://${host}`;
    const sweeper = setInterval(prune, 60_000);
    sweeper.unref();

    return {
        issue(upstreamUrl, ttlMs = DEFAULT_TTL) {
            if (closed) throw new Error('Media server is closed');
            if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL) throw new RangeError('Invalid token TTL');
            // Custom validators may be async; strict production URL syntax is always checked synchronously.
            if (validateUrl === strictUrl) strictUrl(upstreamUrl);
            else new URL(upstreamUrl);
            prune();
            if (tokens.size >= MAX_TOKENS) throw new Error('Media token capacity limit reached');
            const token = randomBytes(32).toString('base64url');
            tokens.set(token, { url: upstreamUrl, expires: Date.now() + ttlMs });
            return `${origin}/media/${token}`;
        },
        revoke(localUrl) {
            if (typeof localUrl !== 'string' || !localUrl.startsWith(`${origin}/media/`)) return;
            const token = localUrl.slice(`${origin}/media/`.length);
            tokens.delete(token);
            for (const operation of active) if (operation.token === token) operation.controller.abort();
        },
        close() {
            if (closing) return closing;
            closed = true;
            clearInterval(sweeper);
            tokens.clear();
            for (const operation of active) operation.controller.abort();
            closing = (async () => {
                const stopped = new Promise((resolve) => server.close(resolve));
                server.closeAllConnections();
                for (const socket of sockets) socket.destroy();
                await Promise.allSettled([...tasks]);
                await stopped;
            })();
            return closing;
        },
    };
}

module.exports = { createMediaServer };
