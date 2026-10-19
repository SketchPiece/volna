/**
 * Страницы входа в Helm MCP в стиле «Штурвала» (холст docs/design/canvas/helm-mcp-passkey, одобрено 19.10.2026):
 * палитра «Бакелит и лампа», IBM Plex, плоско. Текст на английском.
 */
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l3 3M14.5 8.5l2 2"/></svg>';

const STYLE = `:root{--bg:#161310;--surface:#1f1b18;--border:#2a2420;--input:#302924;--text:#efe7d6;--muted:#a3968a;--ph:#8f8376;--lamp:#e8a33d;--lamp-hi:#f2b550;--on-lamp:#161310;--err:#ea7862;color-scheme:dark}
@media(prefers-color-scheme:light){:root{--bg:#e7e0d2;--surface:#fbf6ec;--border:#cfc6b6;--input:#bfb6a6;--text:#26211d;--muted:#5e554b;--ph:#6e655a;--on-lamp:#26211d;--err:#8e2415;color-scheme:light}}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 'IBM Plex Sans',-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;-webkit-font-smoothing:antialiased}
main{width:min(100%,380px)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:40px}
.brand img{width:28px;height:28px;border-radius:7px}
.brand b{font:500 15px 'Unbounded',-apple-system,sans-serif}
.kicker{font:500 11px 'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
h1{font-size:22px;line-height:1.3;font-weight:600;margin-bottom:10px}
p{color:var(--muted);margin-bottom:24px}
input{display:block;width:100%;height:46px;padding:0 14px;border-radius:10px;border:1px solid var(--input);background:var(--surface);color:var(--text);font:inherit;font-size:16px;margin-bottom:12px;outline:none}
input:focus{border-color:var(--lamp)}
input::placeholder{color:var(--ph)}
button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;border:0;border-radius:10px;background:var(--lamp);color:var(--on-lamp);font:600 15px 'IBM Plex Sans',-apple-system,sans-serif;cursor:pointer}
button:hover{background:var(--lamp-hi)}
button:disabled{opacity:.6;cursor:default}
button svg{width:18px;height:18px}
.note{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:24px;color:var(--muted);font-size:13px;line-height:1.45}
.note svg{flex:none;width:18px;height:18px;color:var(--lamp);margin-top:1px}
.note b{color:var(--text);font-weight:500}
.err{color:var(--err);font-size:13px;margin:0 0 12px}
.err:empty{display:none}`;

/** Кодирование base64url и вызовы WebAuthn в браузере; данные страницы в `<script type="application/json" id="data">`. */
const SCRIPT = `const d=JSON.parse(document.getElementById('data').textContent);
const bin=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const btn=document.getElementById('go'),err=document.getElementById('err');
btn.addEventListener('click',async()=>{err.textContent='';btn.disabled=true;
try{const o=d.options;let body;
if(d.mode==='create'){const c=await navigator.credentials.create({publicKey:{...o,challenge:bin(o.challenge),user:{...o.user,id:bin(o.user.id)}}});const r=c.response;
body={id:c.id,clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.getAuthenticatorData()),publicKey:b64(r.getPublicKey()),algorithm:r.getPublicKeyAlgorithm()};}
else{const c=await navigator.credentials.get({publicKey:{...o,challenge:bin(o.challenge),allowCredentials:o.allowCredentials.map(a=>({...a,id:bin(a.id)}))}});const r=c.response;
body={id:c.id,clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.authenticatorData),signature:b64(r.signature)};}
const res=await fetch(d.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:d.ticket,...body})});
const out=await res.json().catch(()=>({}));if(!res.ok)throw new Error(out.error||'Something went wrong. Try again.');location.href=out.redirect;}
catch(e){err.textContent=e&&e.name==='NotAllowedError'?'Cancelled. Try again.':(e&&e.message)||'Something went wrong. Try again.';btn.disabled=false;}});`;

function page(title: string, body: string, data?: object): string {
  const json = data ? `<script type="application/json" id="data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script>${SCRIPT}</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · Helm</title>
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&family=Unbounded:wght@500&display=swap">
<style>${STYLE}</style></head><body><main><div class="brand"><img src="/icon.png" alt=""><b>Helm</b></div>${body}</main>${json}</body></html>`;
}

const access = (client: string) => `${escapeHtml(client)} can read the threads on your computer, write to them, and start or stop work. It shows you every write and asks first.`;
const error = (text?: string) => `<p class="err" id="err" role="alert">${text ? escapeHtml(text) : ''}</p>`;

/** Пароль владельца: пока пасскея нет. `client` — имя клиента OAuth; без него это страница настройки пасскея. */
export function passwordPage(action: string, hidden: Record<string, string>, client: string | null, problem?: string): string {
  const fields = Object.entries(hidden).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('');
  const intro = client
    ? `<div class="kicker">New client</div><h1>Connect ${escapeHtml(client)}</h1><p>${access(client)}</p>`
    : `<div class="kicker">Passkey setup</div><h1>Set up your passkey</h1><p>Enter the owner password once. After that, clients connect with your passkey.</p>`;
  return page(client ? `Connect ${client}` : 'Passkey setup', `${intro}${error(problem)}
<form method="post" action="${escapeHtml(action)}">${fields}
<input type="password" name="password" placeholder="Owner password" autofocus required autocomplete="current-password">
<button type="submit">${client ? 'Allow' : 'Continue'}</button></form>`);
}

/** Пароль принят: создать пасскей. После этого пароль больше не подходит. */
export function createPage(data: { ticket: string; endpoint: string; options: object }): string {
  return page('Create passkey', `<div class="kicker">Password accepted</div><h1>Use a passkey from now on</h1>
<p>Save a passkey to your keychain. It will be on all your Apple devices.</p>
<div class="note">${KEY_ICON}<span><b>The password stops working.</b> After this step you can only sign in with the passkey.</span></div>
${error()}<button id="go" type="button">${KEY_ICON} Create passkey</button>`, { mode: 'create', ...data });
}

export function loginPage(client: string, data: { ticket: string; endpoint: string; options: object }): string {
  return page(`Connect ${client}`, `<div class="kicker">New client</div><h1>Connect ${escapeHtml(client)}</h1><p>${access(client)}</p>
${error()}<button id="go" type="button">${KEY_ICON} Allow with passkey</button>`, { mode: 'get', ...data });
}

export function readyPage(): string {
  return page('Passkey ready', `<div class="kicker">Passkey ready</div><h1>You're set</h1>
<p>Clients that connect to Helm will ask for your passkey. The owner password no longer works.</p>`);
}

export function messagePage(title: string, text: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}
