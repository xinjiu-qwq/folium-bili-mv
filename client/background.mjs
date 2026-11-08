import { safeMediaUrl, syncTarget } from './model.mjs';
import { errorText, mediaErrorText } from './errors.mjs';

// One background owns media at a time; siblings/previews never multiply resolve calls.
export function placeholder(container, text = 'B站 MV · 静态预览 / 导出不加载视频') {
    const node = container.ownerDocument.createElement('div');
    node.textContent = text;
    node.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;background:var(--folium-bg,#181818);color:var(--folium-secondary,#aaa);font:inherit;font-size:12px;';
    container.append(node);
    return () => node.remove();
}

export function mountVideo(folium, model, container, ctx) {
    const doc = container.ownerDocument;
    const frame = doc.createElement('div'); const video = doc.createElement('video'); const shade = doc.createElement('div');
    frame.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--folium-bg,#181818);pointer-events:none;';
    video.style.cssText = 'width:100%;height:100%;display:block;';
    video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'metadata'; video.controls = false;
    video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('aria-hidden', 'true');
    shade.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:none;';
    frame.append(video, shade); container.append(frame);
    let ended = false; let generation = 0; let signature = ''; let media = null; let attempts = 0;
    let blocked = false; let playPending = false; let metadata = false; let lastRetry = model.get().retry;
    let lastAuth = model.get().authRevision; let bindingSignature = ''; let authBlocked = false;
    const unsupported = typeof video.canPlayType === 'function' && video.canPlayType('video/mp4; codecs="avc1.42E01E"') === '';
    const release = url => { if (url) void folium.rpc.call('release', url).catch(() => {}); };
    const clear = () => {
        generation++; metadata = false; playPending = false; video.pause();
        video.removeAttribute('src'); video.load();
        const old = media; media = null; release(old?.url);
    };
    function style() {
        const settings = ctx.getSettings();
        video.style.objectFit = settings.fit === 'cover' ? 'cover' : 'contain';
        shade.style.opacity = String(Number.isFinite(settings.dim) ? Math.max(0, Math.min(0.9, settings.dim)) : 0.35);
        frame.style.backgroundColor = ctx.getTheme().backgroundColor;
    }
    function sync() {
        if (ended || !media || !metadata || video.readyState < 1) return;
        const binding = model.get().binding;
        if (!binding) return;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : media.duration;
        const target = syncTarget(folium.playback.getState(), binding.offset, duration);
        try { if (Math.abs(video.currentTime - target.time) > 0.35) video.currentTime = target.time; }
        catch { return; }
        if (!target.playing || ctx.isPaused()) { video.pause(); return; }
        if (blocked || playPending || !video.paused) return;
        const gen = generation; playPending = true;
        Promise.resolve().then(() => {
            if (ended || gen !== generation) return;
            return video.play();
        }).then(() => {
            if (ended || gen !== generation) return;
            playPending = false;
            const latest = syncTarget(folium.playback.getState(), model.get().binding?.offset ?? 0, duration);
            if (!latest.playing || ctx.isPaused()) video.pause();
        }, () => {
            if (ended || gen !== generation) return;
            playPending = false; blocked = true; video.pause(); model.report('视频播放被阻止，请点击“重试播放”');
        });
    }
    async function resolve() {
        const binding = model.get().binding;
        if (!binding || ended || authBlocked) return;
        if (unsupported) { model.report('当前浏览器不支持 H.264 / AVC 视频解码，请使用支持该编码的浏览器或应用版本'); return; }
        const gen = ++generation;
        model.report('正在加载 MV…');
        try {
            const result = await folium.rpc.call('resolve', { bvid: binding.bvid, cid: binding.cid });
            const url = safeMediaUrl(result?.url);
            if (ended || gen !== generation) { release(url); return; }
            if (!url || !Number.isFinite(result.duration) || result.duration <= 0 || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) {
                release(url); throw Error('bili:invalid-response');
            }
            media = { url, duration: result.duration, expiresAt: result.expiresAt }; metadata = false; blocked = false;
            video.src = url; video.load(); model.report('MV 已加载，等待视频元数据');
        } catch (error) {
            if (!ended && gen === generation) model.report(`${errorText(error, 'MV 加载')}；请点击“重试播放”`);
        }
    }
    function recover(event) {
        if (ended || !signature || authBlocked || !media) return;
        const code = event ? video.error?.code : undefined;
        clear();
        if (code !== 3 && code !== 4 && attempts++ < 1) void resolve();
        else model.report(`${mediaErrorText(code)}；已停止自动重试`);
    }
    function update() {
        if (ended) return;
        const state = model.get(); const b = state.binding;
        const nextBinding = b ? JSON.stringify([state.key, b.bvid, b.cid]) : '';
        const next = b ? JSON.stringify([state.key, b.bvid, b.cid, state.authRevision]) : '';
        const changedAuth = state.authRevision !== lastAuth; lastAuth = state.authRevision;
        if (changedAuth) authBlocked = true;
        if (nextBinding !== bindingSignature) { bindingSignature = nextBinding; authBlocked = false; }
        if (next !== signature) {
            signature = next; attempts = 0; blocked = false; clear();
            if (next && !authBlocked) void resolve();
        }
        if (state.retry !== lastRetry) {
            lastRetry = state.retry; blocked = false; authBlocked = false;
            if (!media && next) { attempts = 0; void resolve(); }
        }
        sync();
    }
    const onMetadata = () => { if (!media || ended) return; metadata = true; model.report('MV 已就绪'); sync(); };
    video.addEventListener('loadedmetadata', onMetadata); video.addEventListener('error', recover);
    const releaseModel = model.acquire();
    const unsub = model.subscribe(update);
    const unchange = ctx.onChange(() => { style(); sync(); });
    const untick = folium.every(500, () => {
        if (media && media.expiresAt <= Date.now()) recover();
        else sync();
    });
    style(); update();
    return () => {
        if (ended) return; ended = true;
        unsub(); unchange(); untick();
        video.removeEventListener('loadedmetadata', onMetadata); video.removeEventListener('error', recover);
        clear(); releaseModel(); frame.remove();
    };
}
