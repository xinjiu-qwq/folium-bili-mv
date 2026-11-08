import { defaultKeyword, safeCoverUrl } from './model.mjs';
import { mountAccount } from './account.mjs';

// A compact schema-backed settings panel; untrusted labels are always text nodes.
export function mountPanel(model, container, ctx, account) {
    const doc = container.ownerDocument; const root = doc.createElement('section'); const cleanups = [];
    const make = (tag, text = '') => { const node = doc.createElement(tag); node.textContent = text; return node; };
    const listen = (node, event, fn) => { node.addEventListener(event, fn); cleanups.push(() => node.removeEventListener(event, fn)); };
    const style = make('style');
    style.textContent = `
        section{font:inherit;font-size:13px;line-height:1.5;min-width:0;color:var(--mv-primary);--mv-blue:#00a1d6}
        *{box-sizing:border-box} p{margin:0 0 8px;overflow-wrap:anywhere}
        .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}
        input,button{font:inherit;color:inherit;border:1px solid var(--mv-secondary);border-radius:5px;background:transparent;padding:6px 9px;min-width:0}
        input{accent-color:var(--mv-blue)} input[type=search]{flex:1;min-width:100px} input[type=number]{width:92px}
        button{cursor:pointer} button:hover{border-color:var(--mv-blue)} button:disabled{cursor:default;opacity:.45}
        button:focus-visible,input:focus-visible{outline:2px solid var(--mv-blue);outline-offset:2px}
        .primary{background:var(--mv-blue);border-color:var(--mv-blue);color:#fff}
        ul{list-style:none;padding:0;margin:0;max-height:300px;overflow:auto}
        li{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--mv-secondary)}
        .meta{flex:1;min-width:0;overflow-wrap:anywhere}.muted,small{color:var(--mv-secondary)}
        img{width:64px;height:40px;object-fit:cover;border-radius:3px} label{display:flex;align-items:center;gap:6px}
    `;
    const current = make('p'); const bound = make('p'); bound.className = 'muted';
    const form = make('form'); form.className = 'row'; const query = make('input'); query.type = 'search'; query.maxLength = 100; query.setAttribute('aria-label', 'MV 搜索关键词');
    const search = make('button', '搜索'); search.type = 'submit'; search.className = 'primary'; form.append(query, search);
    const status = make('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const results = make('ul'); results.setAttribute('aria-label', 'MV 搜索结果');
    const pages = make('ul'); pages.setAttribute('aria-label', '视频分P');
    const actions = make('div'); actions.className = 'row'; const unbind = make('button', '解除绑定'); const retry = make('button', '重试播放'); unbind.type = retry.type = 'button'; actions.append(unbind, retry);
    const syncRow = make('div'); syncRow.className = 'row'; const offsetLabel = make('label', '同步偏移（秒）'); const offset = make('input'); offset.type = 'number'; offset.min = '-3600'; offset.max = '3600'; offset.step = '0.1'; offsetLabel.append(offset); syncRow.append(offsetLabel);
    const hint = make('p', '视频时间 = 歌曲时间 + 偏移；负时间或超出视频长度时暂停。'); hint.className = 'muted';
    const visuals = make('div'); visuals.className = 'row'; const contain = make('button', '完整显示'); const cover = make('button', '裁切填满'); contain.type = cover.type = 'button';
    const dimLabel = make('label', '暗化'); const dim = make('input'); dim.type = 'range'; dim.min = '0'; dim.max = '0.9'; dim.step = '0.05'; dimLabel.append(dim); visuals.append(contain, cover, dimLabel);
    root.append(style, current, bound, form, status, results, pages, actions, syncRow, hint, visuals);
    if (account) cleanups.push(mountAccount(account, root, ctx));
    container.append(root);
    let ended = false; let key; let resultRef; let detailRef; let rowCleanups = []; let pageCleanups = [];
    const theme = () => { const t = ctx.getTheme(); root.style.setProperty?.('--mv-primary', t.primaryColor); root.style.setProperty?.('--mv-secondary', t.secondaryColor); root.style.fontFamily = 'inherit'; };
    function visualSettings() {
        const values = ctx.settings.get();
        contain.setAttribute('aria-pressed', String(values.fit !== 'cover')); cover.setAttribute('aria-pressed', String(values.fit === 'cover'));
        dim.value = String(values.dim ?? 0.35);
    }
    function paint() {
        if (ended) return;
        const state = model.get();
        if (key !== state.key) { key = state.key; query.value = defaultKeyword(state.song); }
        current.textContent = state.song ? `当前歌曲：${state.song.title} / ${state.song.artist}` : '当前没有歌曲';
        bound.textContent = state.binding ? `已绑定：${state.binding.title} · P${state.binding.page} · ${state.binding.bvid}` : '尚未绑定 MV；搜索并选择视频，不会自动绑定首项。';
        status.textContent = state.status;
        search.disabled = !state.key || state.busy; unbind.disabled = !state.binding; retry.disabled = !state.binding; offset.disabled = !state.binding;
        if ((root.getRootNode?.()?.activeElement ?? doc.activeElement) !== offset) offset.value = String(state.binding?.offset ?? 0);
        if (resultRef !== state.results) {
            resultRef = state.results; rowCleanups.splice(0).forEach(fn => fn()); results.replaceChildren();
            for (const result of state.results) {
                const row = make('li'); const info = make('div'); info.className = 'meta'; const title = make('span', result.title); const meta = make('small', `${result.author} · ${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')}`); info.append(title, make('br'), meta);
                const coverUrl = safeCoverUrl(result.cover);
                if (coverUrl) {
                    const img = make('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy';
                    const fail = () => { img.removeAttribute('src'); img.remove(); }; img.addEventListener('error', fail); rowCleanups.push(() => img.removeEventListener('error', fail)); img.src = coverUrl; row.append(img);
                }
                const choose = make('button', '选择视频'); choose.type = 'button'; choose.setAttribute('aria-label', `选择视频：${result.title}`);
                const select = () => { void model.select(result); }; choose.addEventListener('click', select); rowCleanups.push(() => choose.removeEventListener('click', select));
                row.append(info, choose); results.append(row);
            }
        }
        if (detailRef !== state.details) {
            detailRef = state.details; pageCleanups.splice(0).forEach(fn => fn()); pages.replaceChildren();
            if (state.details) for (const page of state.details.pages) {
                const row = make('li'); const title = make('span', `P${page.page} ${page.title}`); title.className = 'meta'; const choose = make('button', '绑定此分P'); choose.type = 'button'; choose.setAttribute('aria-label', `绑定分P ${page.page}：${page.title}`);
                const details = state.details; const selectedKey = state.key;
                const bind = () => { if (model.get().key !== selectedKey) return; void model.bind({ bvid: details.bvid, cid: page.cid, page: page.page, title: details.title, offset: model.get().binding?.offset ?? 0 }); };
                choose.addEventListener('click', bind); pageCleanups.push(() => choose.removeEventListener('click', bind)); row.append(title, choose); pages.append(row);
            }
        }
    }
    const submit = event => { event.preventDefault(); void model.search(query.value); };
    listen(form, 'submit', submit);
    // Explicit click also supports minimal DOM hosts; suppress the native submit to avoid duplicate RPC.
    listen(search, 'click', submit);
    listen(unbind, 'click', () => { void model.bind(null); }); listen(retry, 'click', () => model.retry());
    listen(offset, 'change', () => { const n = Number(offset.value); if (offset.value.trim() && Number.isFinite(n) && Math.abs(n) <= 3600) void model.setOffset(n); else { model.report('同步偏移需为 -3600 到 3600 秒之间的数字'); paint(); } });
    listen(contain, 'click', () => ctx.settings.set({ fit: 'contain' })); listen(cover, 'click', () => ctx.settings.set({ fit: 'cover' })); listen(dim, 'input', () => ctx.settings.set({ dim: Number(dim.value) }));
    const releaseModel = model.acquire(); const unsubscribe = model.subscribe(paint); const closePanel = model.openPanel();
    const untheme = ctx.onChange(theme); const unset = ctx.settings.onChange(visualSettings);
    theme(); visualSettings(); paint();
    return () => { if (ended) return; ended = true; closePanel(); unsubscribe(); untheme(); unset(); releaseModel(); cleanups.splice(0).forEach(fn => fn()); rowCleanups.splice(0).forEach(fn => fn()); pageCleanups.splice(0).forEach(fn => fn()); root.remove(); };
}
