// P0 测试页（由回显服务提供，地址 http://echo.p0.example.test:<端口>/）。poll 模式每秒请求回显与检测服务并保持
// 一条 WebSocket；attr 模式提供逐项测试按钮。页面只上报结果（成功与否、耗时、经过的测试节点、IP 版本），
// 不上报出口 IP、浏览记录或请求头。

export interface PageConfig {
  app: string;
  mode: 'poll' | 'attr';
  verifyUrl: string;
  ipv6Url: string;
  h3Url: string;
  intervalMs: number;
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function testPageHtml(cfg: PageConfig): string {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SFE P0 测试页</title>
<style>
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:16px;color:#1f2937;background:#fff}
h1{font-size:18px;margin:0 0 8px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
button{padding:6px 12px;border:1px solid #0d9488;background:#f0fdfa;color:#0f766e;border-radius:6px;cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:12px}
td,th{border-bottom:1px solid #e5e7eb;padding:4px 6px;text-align:left}
.ok{color:#047857}.fail{color:#b91c1c}.muted{color:#6b7280}
code{background:#f3f4f6;padding:1px 4px;border-radius:4px}
</style>
</head>
<body>
<h1>SFE P0 测试页 · <span id="app"></span></h1>
<p class="muted">只用于 P0 实测。页面只上报成功与否、耗时、经过的测试节点与 IP 版本，不上报出口 IP。</p>
<div class="bar" id="buttons"></div>
<p>WebSocket：<span id="ws">未连接</span> · 已上报 <span id="sent">0</span> 条 · 待上报 <span id="pending">0</span> 条</p>
<table><thead><tr><th>时间</th><th>项目</th><th>结果</th><th>耗时</th><th>经过</th></tr></thead><tbody id="rows"></tbody></table>
<script>
(function(){
var cfg=${json(cfg)};
var events=[],sent=0,seq=0,ws=null,wsOpenedAt=0,wsMsgs=0,wsVia=null;
document.getElementById('app').textContent=cfg.app+'（'+(cfg.mode==='poll'?'轮询':'归属测试')+'）';
function row(kind,ok,ms,via){var tr=document.createElement('tr');var d=new Date();
tr.innerHTML='<td>'+d.toLocaleTimeString()+'</td><td>'+kind+'</td><td class="'+(ok?'ok':'fail')+'">'+(ok?'成功':'失败')+'</td><td>'+(ms==null?'':ms+' ms')+'</td><td>'+(via||'')+'</td>';
var tb=document.getElementById('rows');tb.insertBefore(tr,tb.firstChild);while(tb.children.length>30)tb.removeChild(tb.lastChild);}
function push(kind,data){var e={t:Date.now(),kind:kind};for(var k in data)e[k]=data[k];if(events.length<5000)events.push(e);row(kind,!!data.ok,data.ms,data.via);document.getElementById('pending').textContent=events.length;}
function timed(url){var t0=performance.now();var ctl=new AbortController();var tm=setTimeout(function(){ctl.abort();},4000);
return fetch(url,{cache:'no-store',credentials:'omit',signal:ctl.signal}).then(function(r){clearTimeout(tm);return r.json().catch(function(){return null;}).then(function(b){return{ok:r.ok,status:r.status,ms:Math.round(performance.now()-t0),body:b};});})
.catch(function(e){clearTimeout(tm);return{ok:false,status:null,ms:Math.round(performance.now()-t0),error:String(e&&e.name||'error')};});}
function withTest(url,id){return url+(url.indexOf('?')>=0?'&':'?')+'sfe_test='+encodeURIComponent(id);}
function ipVersion(b){var ip=b&&typeof b.ip==='string'?b.ip:null;return ip?(ip.indexOf(':')>=0?6:4):null;}
function echoOnce(label){seq++;return timed('/ip?t='+encodeURIComponent(cfg.app+'-'+seq)+'&app='+encodeURIComponent(cfg.app)).then(function(r){
push(label||'echo',{seq:seq,ok:r.ok,status:r.status,ms:r.ms,via:r.body&&r.body.via||null,front:r.body?r.body.throughFront:null,error:r.error||null});});}
function verifyOnce(label,url){seq++;return timed(withTest(url||cfg.verifyUrl,cfg.app+'-'+seq)).then(function(r){
push(label||'verify',{seq:seq,ok:r.ok,status:r.status,ms:r.ms,ipVersion:ipVersion(r.body),error:r.error||null});});}
function wsConnect(){try{ws=new WebSocket('ws://'+location.host+'/ws?app='+encodeURIComponent(cfg.app));}catch(e){push('ws_error',{ok:false});return;}
var opened=false;ws.onopen=function(){opened=true;wsOpenedAt=Date.now();wsMsgs=0;document.getElementById('ws').textContent='已连接';push('ws_open',{ok:true});};
ws.onmessage=function(m){wsMsgs++;try{var d=JSON.parse(m.data);if(d.via!==undefined)wsVia=d.via;}catch(e){}document.getElementById('ws').textContent='已连接（'+wsMsgs+' 条，经过 '+(wsVia||'未知')+'）';};
ws.onclose=function(){document.getElementById('ws').textContent='已断开';if(opened)push('ws_close',{ok:false,openMs:Date.now()-wsOpenedAt,messages:wsMsgs,via:wsVia});ws=null;if(cfg.mode==='poll')setTimeout(wsConnect,2000);};}
function report(){if(events.length===0)return;var batch=events.splice(0,500);
fetch('/report',{method:'POST',cache:'no-store',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({app:cfg.app,events:batch})})
.then(function(r){if(!r.ok)throw new Error('report');sent+=batch.length;document.getElementById('sent').textContent=sent;})
.catch(function(){events=batch.concat(events).slice(0,5000);}).then(function(){document.getElementById('pending').textContent=events.length;});}
function webrtc(){if(!window.RTCPeerConnection){push('webrtc',{ok:false,error:'unsupported'});return;}
var pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});var srflx=0,host=0;pc.createDataChannel('p0');
pc.onicecandidate=function(e){if(!e.candidate){push('webrtc',{ok:srflx>0,srflx:srflx,host:host});pc.close();return;}var c=e.candidate.candidate||'';if(c.indexOf(' srflx ')>=0)srflx++;else if(c.indexOf(' host ')>=0)host++;};
pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(function(){push('webrtc',{ok:false,error:'offer'});});}
function button(label,fn){var b=document.createElement('button');b.textContent=label;b.onclick=fn;document.getElementById('buttons').appendChild(b);}
if(cfg.mode==='attr'){
button('HTTP/1.1（回显）',function(){echoOnce('http1');});
button('IPv4（检测服务）',function(){verifyOnce('ipv4',cfg.verifyUrl);});
button('IPv6',function(){verifyOnce('ipv6',cfg.ipv6Url);});
button('WebSocket',function(){if(ws){ws.close();}else{wsConnect();}});
button('打开 HTTP/2 · HTTP/3 测试页',function(){window.open(cfg.h3Url,'_blank');});
button('WebRTC（只计数候选）',webrtc);
}else{
var busy=false;
setInterval(function(){if(busy)return;busy=true;echoOnce().then(function(){return verifyOnce();}).then(function(){busy=false;});},cfg.intervalMs);
wsConnect();
}
setInterval(report,3000);
})();
</script>
</body>
</html>
`;
}
