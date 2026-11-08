// Optional real-DOM smoke test. No npm dependencies; only --live requests external media.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'bili-mv-browser-'));
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const live = process.argv.includes('--live');
let liveServer, liveClient, liveUrl;
if (live) {
  const { createBilibiliClient } = await import('../lib/bilibili.cjs');
  const { createMediaServer } = await import('../lib/media-server.cjs');
  liveClient = createBilibiliClient();
  try {
    const details = await liveClient.details('BV17x411w7KC');
    const stream = await liveClient.resolve({ bvid: details.bvid, cid: details.pages[0].cid });
    liveServer = await createMediaServer();
    liveUrl = liveServer.issue(stream.url);
  } catch (error) { liveClient.close(); await liveServer?.close(); await rm(profile,{recursive:true,force:true}); throw error; }
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Bili MV DOM test</title>
<body style="font:14px sans-serif;background:#202938;color:white"><main id="panel" style="width:430px"></main>
<script type="module">
import activate from '/client.mjs';
const registered = []; const sections = []; const listeners = new Map(); const rpcListeners = new Map(); const calls = []; const data = new Map();
let accountState = {loggedIn:false,name:'',status:'logged-out',revision:0};
let song = {source:'local',id:'a',title:'测试歌曲',artist:'测试歌手'};
let snapshot = {song,state:'paused',position:10,duration:180};
const folium = {
 env:{context:'main'},host:{folium:{major:1,minor:8},folia:'0.7.27'},
 log:{info(){},warn(){},error(){}},onDispose(){},every(ms,fn){const id=setInterval(fn,ms);return ()=>clearInterval(id);},
 registries:{backgrounds:{register(def){registered.push(def);return {unregister(){}};}},settingsSections:{register(def){sections.push(def);return {unregister(){}};}},commands:{register(){return {unregister(){}};}}},
 playback:{getState(){return snapshot;}},
 events:{on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return ()=>listeners.get(name).delete(fn);}},
 storage:{async get(key){return data.get(key);},async set(key,value){data.set(key,structuredClone(value));},async delete(key){data.delete(key);}},
 rpc:{on(name,fn){rpcListeners.set(name,fn);return ()=>rpcListeners.delete(name);},async call(name,...args){calls.push([name,...args]);
  if(name==='account.status'||name==='account.open')return {...accountState};
  if(name==='account.check'){accountState={loggedIn:true,name:'测试账号',status:'logged-in',revision:1};rpcListeners.get('account.changed')?.({...accountState});return {...accountState};}
  if(name==='account.logout'){accountState={loggedIn:false,name:'',status:'logged-out',revision:2};rpcListeners.get('account.changed')?.({...accountState});return {...accountState};}
  if(name==='search')return [{bvid:'BV1xx411c7mD',title:'<img src=x onerror=alert(1)> 测试 MV',author:'测试UP主',duration:180,cover:null}];
  if(name==='details')return {bvid:'BV1xx411c7mD',title:'测试 MV',pages:[{cid:100,page:1,title:'正片',duration:180},{cid:101,page:2,title:'PV',duration:170}]};
  if(name==='release')return null;
  throw Error('This smoke test must not resolve media');
 }},ui:{toast(){}}
};
const dispose = await activate(folium);
const def = registered[0]; if(!def)throw Error('No background registered');
let values = Object.fromEntries(def.settings.map(field=>[field.key,field.defaultValue]));
const changes = new Set();
const settings = {schema:def.settings,get:()=>values,set(patch){values={...values,...patch};changes.forEach(f=>f());},reset(){},onChange(fn){changes.add(fn);return ()=>changes.delete(fn);}};
const cleanups=[];
const ctx = {locale:'zh-CN',settings,getTheme:()=>({background:'#202938',foreground:'#ffffff',primary:'#00aeec',accent:'#00aeec',text:'#ffffff'}),
 onChange(){return ()=>{};},onResize(){return ()=>{};},onFrame(){return ()=>{};},onDispose(fn){cleanups.push(fn);},every(ms,fn){const id=setInterval(fn,ms);const off=()=>clearInterval(id);cleanups.push(off);return off;}};
const panelRoot = document.querySelector('#panel').attachShadow({mode:'open'});
const panelContainer = document.createElement('div'); panelRoot.append(panelContainer);
const stopPanel = await def.settingsPanel(panelContainer,ctx);
window.qa = {root:panelRoot,sections,calls,data,def,settings,emit(){listeners.get('playback.stateChanged')?.forEach(fn=>fn({state:'paused'}));},async stop(){stopPanel?.();cleanups.forEach(f=>f());dispose?.();},changeSong(){song={...song,id:'b',title:'另一首歌曲'};snapshot={...snapshot,song};listeners.get('playback.songChanged')?.forEach(fn=>fn({song}));}};
window.qaReady=true;
</script></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(resolve(root) + sep) || !['.mjs', '.js'].includes(extname(path))) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let child, ws;
try {
  child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const waitFor = async (read, message) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const result = await read(); if (result) return result; await delay(50); }
    throw Error(message);
  };
  const port = await waitFor(async () => {
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; }
  }, 'Chrome did not expose DevTools');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl); await once(ws, 'open');
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', event => { const msg = JSON.parse(event.data); if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p?.reject(Error(msg.error.message)) : p?.resolve(msg.result); } if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.text+': '+(msg.params.exceptionDetails.exception?.description||'')); });
  const send = (method, params={}) => new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate = async expression => {const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await send('Runtime.enable');
  await send('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/`});
  await waitFor(()=>evaluate('window.qaReady===true'), 'Client settings panel did not mount');
  assert.equal(await evaluate('window.qa.def.id'), 'mv');
  assert.equal(await evaluate('window.qa.sections.some(s=>s.id==="account" && s.settings.some(f=>f.type==="secret" && f.key==="bilibili-session"))'), true, 'Account settings section missing');
  await waitFor(()=>evaluate('[...window.qa.root.querySelectorAll("button")].some(b=>b.textContent.includes("登录窗"))'), 'Official login entry missing in MV settings');
  await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent.includes("登录窗")).click()');
  await waitFor(()=>evaluate('window.qa.calls.some(c=>c[0]==="account.open")'), 'Login button did not call main');
  await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent.includes("检查登录")).click()');
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("测试账号")'), 'Verified account not displayed');
  await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent.includes("退出登录")).click()');
  await waitFor(()=>evaluate('window.qa.calls.some(c=>c[0]==="account.logout") && !window.qa.root.textContent.includes("测试账号")'), 'Logout did not clear account state');
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("测试歌曲")'), 'Current song missing');
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("测试UP主") || [...window.qa.root.querySelectorAll("button")].some(b=>b.textContent.includes("搜索"))'), 'Search missing');
  if(!await evaluate('window.qa.root.textContent.includes("测试UP主")')) {
    await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent.includes("搜索")).click()');
  }
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("测试UP主")'), 'Search did not display results');
  assert.equal(await evaluate('window.qa.root.querySelectorAll("img[src=x]").length'), 0, 'Search title was interpreted as HTML');
  assert.equal(await evaluate('window.qa.calls.filter(c=>c[0]==="resolve").length'), 0, 'Unselected result started media');
  await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent==="选择视频").click()');
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("P2 PV")'), 'Video pages did not appear');
  await evaluate('[...window.qa.root.querySelectorAll("button")].filter(b=>b.textContent==="绑定此分P")[1].click()');
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("已绑定：") && window.qa.root.textContent.includes("P2") && window.qa.data.size>0'), 'Page binding was not persisted');
  await evaluate('const offset=window.qa.root.querySelector("input[type=number]");offset.focus();offset.value="-3.5";window.qa.emit();');
  assert.equal(await evaluate('window.qa.root.querySelector("input[type=number]").value'), '-3.5', 'ShadowRoot focus lost in-progress offset edit');
  await evaluate('{ const offset=window.qa.root.querySelector("input[type=number]");offset.value="2.5";offset.dispatchEvent(new Event("change",{bubbles:true}));offset.blur(); }');
  await waitFor(()=>evaluate('JSON.stringify([...window.qa.data.values()]).includes("2.5")'), 'Per-song offset was not persisted');
  await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent==="裁切填满").click()');
  assert.equal(await evaluate('window.qa.settings.get().fit'), 'cover');
  await evaluate('[...window.qa.root.querySelectorAll("button")].find(b=>b.textContent==="解除绑定").click()');
  await waitFor(()=>evaluate('!window.qa.root.textContent.includes("已绑定：")'), 'Unbind did not clear selection');
  await evaluate('window.qa.changeSong()');
  await waitFor(()=>evaluate('window.qa.root.textContent.includes("另一首歌曲")'), 'Song change did not refresh panel');
  await evaluate('window.qa.stop()');
  assert.deepEqual(errors, []);
  console.log('PASS: Chrome ShadowRoot account open/check/logout, search, safe text, page binding, offset persistence, fit, unbind, song change, cleanup');
  if (live) {
    await evaluate(`window.liveVideo=document.createElement('video');window.liveVideo.muted=true;window.liveVideo.preload='auto';document.body.append(window.liveVideo);window.liveVideo.src=${JSON.stringify(liveUrl)};window.liveVideo.load();`);
    await waitFor(()=>evaluate('window.liveVideo.readyState>=2 || (window.liveVideo.error && (()=>{throw Error("Video error "+window.liveVideo.error.code+": "+window.liveVideo.error.message)})())'), 'Live media did not load');
    const duration = await evaluate('window.liveVideo.duration'); assert.ok(duration>0);
    await evaluate('window.liveVideo.currentTime=30;window.liveVideo.play()');
    await waitFor(()=>evaluate('window.liveVideo.currentTime>30.1 && !window.liveVideo.paused'), 'Live media did not play after seek');
    console.log(`PASS: live Bilibili AVC via restricted proxy, metadata (${duration}s), seek and muted Chrome playback`);
    await evaluate('window.liveVideo.pause();window.liveVideo.removeAttribute("src");window.liveVideo.load();window.liveVideo.remove()');
  }
} finally {
  ws?.close(); child?.kill(); await new Promise(r=>server.close(r));
  liveClient?.close(); await liveServer?.close();
  await rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{});
}
