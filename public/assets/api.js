async function api(path, opts = {}){
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'include'
  });
  let data = null;
  try { data = await res.json(); } catch(e) { /* no body */ }
  if (!res.ok){
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function initNav(){
  try{
    const me = await api('/api/me');
    const el = document.getElementById('whoName');
    if (el) el.textContent = me.username;
  }catch(e){
    if (e.status === 401){ window.location.href = '/login'; }
  }
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn){
    logoutBtn.addEventListener('click', async () => {
      try{ await api('/api/logout', { method:'POST' }); }catch(e){}
      window.location.href = '/login';
    });
  }
}
document.addEventListener('DOMContentLoaded', initNav);
