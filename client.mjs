import { createModel } from './client/model.mjs';
import { mountVideo, placeholder } from './client/background.mjs';
import { mountPanel } from './client/panel.mjs';
import { createAccount, mountAccount } from './client/account.mjs';

// Folium registration only: media and song data are lazily acquired by live mounts.
export default function activate(folium) {
    const account = createAccount(folium);
    const model = createModel(folium, account);
    const mounts = new Set(); const panels = new Set(); let active = null; let ended = false;
    function panel(container, ctx, mount) {
        if (ended || folium.env.context !== 'main' || ctx.staticMode) return placeholder(container, 'B站 MV · 静态预览 / 导出不加载账号、视频或歌曲数据');
        const cleanup = mount(container, ctx); let disposed = false;
        const dispose = () => { if (disposed) return; disposed = true; panels.delete(dispose); cleanup(); };
        panels.add(dispose); return dispose;
    }
    const accountSection = folium.registries.settingsSections.register({
        id: 'account',
        label: { 'zh-CN': 'B站账号', 'zh-TW': 'B站帳號', en: 'Bilibili account' },
        settings: [{ type: 'secret', key: 'bilibili-session', label: { 'zh-CN': 'B站会话', en: 'Bilibili session' } }],
        settingsPanel(container, ctx) { return panel(container, ctx, (target, context) => mountAccount(account, target, context)); },
    });
    function promote() {
        if (ended || active) return;
        const next = mounts.values().next().value;
        if (!next) return;
        active = next; next.clear(); next.clear = mountVideo(folium, model, next.container, next.ctx);
    }
    const background = folium.registries.backgrounds.register({
        id: 'mv',
        label: { 'zh-CN': 'B站 MV', 'zh-TW': 'B站 MV', en: 'Bilibili MV' },
        settings: [
            { key: 'fit', type: 'select', label: { 'zh-CN': '视频显示', en: 'Video fit' }, defaultValue: 'contain', options: [
                { value: 'contain', label: { 'zh-CN': '完整显示', en: 'Contain' } },
                { value: 'cover', label: { 'zh-CN': '裁切填满', en: 'Cover' } },
            ] },
            { key: 'dim', type: 'number', label: { 'zh-CN': '暗化', en: 'Dim' }, min: 0, max: 0.9, step: 0.05, defaultValue: 0.35 },
        ],
        mount(container, ctx) {
            if (ended || folium.env.context !== 'main' || ctx.staticMode) return placeholder(container);
            const entry = { container, ctx, clear: placeholder(container, 'B站 MV · 视频已在另一背景挂载中显示') };
            mounts.add(entry); promote(); let disposed = false;
            return () => {
                if (disposed) return; disposed = true; mounts.delete(entry); entry.clear();
                if (active === entry) { active = null; promote(); }
            };
        },
        settingsPanel(container, ctx) {
            return panel(container, ctx, (target, context) => mountPanel(model, target, context, account));
        },
    });
    return () => {
        if (ended) return; ended = true;
        panels.forEach(fn => fn()); mounts.forEach(entry => entry.clear()); mounts.clear(); active = null;
        model.dispose(); account.dispose(); background.unregister(); accountSection.unregister();
    };
}
