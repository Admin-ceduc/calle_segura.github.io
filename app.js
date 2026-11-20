(() => {
const API = location.protocol === 'file:' ? 'http://localhost:5000' : '';
const loadUser = () => {
  try { return JSON.parse(localStorage.getItem('cs_user') || 'null'); }
  catch { localStorage.removeItem('cs_user'); return null; }
};
const CATS = {
  em: {
    Carabineros: ['Robo o asalto', 'Accidente', 'Persona en riesgo', 'Violencia intrafamiliar', 'Otro'],
    Bomberos: ['Incendio', 'Rescate', 'Fuga de gas', 'Accidente', 'Otro'],
    Ambulancia: ['Accidente', 'Emergencia médica', 'Persona en riesgo', 'Otro'],
    'Seguridad municipal': ['Robo o asalto', 'Persona en riesgo', 'Ruido molesto', 'Vandalismo', 'Otro'],
    Otro: ['Emergencia general', 'Otro']
  },
  pr: ['Luminaria apagada', 'Basura acumulada', 'Bache o vereda dañada', 'Grafiti', 'Otro']
};
const SERVICES = ['Carabineros', 'Bomberos', 'Ambulancia', 'Seguridad municipal', 'Otro'];
const STATUSES = ['Nuevo', 'Visto', 'En curso', 'Resuelto'];
const LEBU_CENTER = [-37.6163, -73.6511];
const B = { minLat: -37.66, maxLat: -37.57, minLon: -73.70, maxLon: -73.60 };
const LEBU_BOUNDS = [[B.minLat, B.minLon], [B.maxLat, B.maxLon]];
const S = { user: loadUser(), reports: [], users: [], filter: 'all', sel: null, type: 'em', pick: null, form: {}, tracking: null };
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isStaff = () => S.user && ['staff', 'admin'].includes(S.user.role);

async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.user?.token) headers.Authorization = `Bearer ${S.user.token}`;
  const r = await fetch(API + path, opts ? { ...opts, headers, body: JSON.stringify(opts.body) } : { headers });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(d.error || 'Error de servidor');
    error.status = r.status;
    throw error;
  }
  return d;
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}
function ago(s) {
  const m = Math.max(0, Math.round((Date.now() - new Date(s.replace(' ', 'T') + 'Z')) / 60000));
  if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60); return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}
const tag = r => `<span class="tag t-${r.type}">${r.type === 'em' ? 'Emergencia' : 'Problema'}</span> <span class="tag s-${r.status.replace(' ', '-')}">${esc(r.status)}</span>`;

/* ---------- mapa de Lebu ---------- */
function mapHTML(kind = 'all') {
  const pick = kind === 'picker';
  return `<div class="leaflet-map ${pick ? 'pick' : ''}" id="${pick ? 'pickmap' : `map-${kind}`}" data-leaflet-map="${kind}" role="application" aria-label="Mapa de reportes de Lebu"></div>`;
}
function markerIcon(type) {
  return L.divIcon({
    className: 'report-marker-icon',
    html: `<span class="report-marker ${type}" aria-hidden="true"><span>✓</span></span>`,
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    popupAnchor: [0, -40]
  });
}
let pickMap = null, pickLayer = null;
function drawPick(recenter) {
  if (!pickMap || !pickLayer || !S.pick || !document.body.contains(pickMap.getContainer())) return;
  const p = [S.pick.lat, S.pick.lon];
  pickLayer.clearLayers();
  L.circleMarker(p, { radius: 10, color: '#fff', weight: 4, fillColor: '#2D7DE0', fillOpacity: 1 }).addTo(pickLayer);
  L.circle(p, { radius: 35, color: '#2D7DE0', weight: 2, fill: false, opacity: .55 }).addTo(pickLayer);
  if (recenter) pickMap.setView(p, Math.max(pickMap.getZoom(), 16));
}
function setPick(lat, lon, recenter) {
  S.pick = { lat, lon };
  saveReportForm();
  drawPick(recenter);
  const hint = $('#pickhint');
  if (hint) hint.textContent = 'Ubicación marcada ✓';
}
function initMaps() {
  if (!window.L) return;
  document.querySelectorAll('[data-leaflet-map]').forEach(el => {
    if (el._leaflet_id) return;
    const kind = el.dataset.leafletMap;
    const pick = kind === 'picker';
    const list = kind === 'filtered' ? S.reports.filter(r => S.filter === 'all' || r.type === S.filter) : S.reports;
    const point = pick ? S.pick : null;
    const center = point ? [point.lat, point.lon] : LEBU_CENTER;
    const map = L.map(el, { zoomControl: true, maxBounds: LEBU_BOUNDS, maxBoundsViscosity: 1 }).setView(center, point ? 16 : 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const markerBounds = [];
    list.forEach(r => {
      const position = [r.latitude, r.longitude];
      markerBounds.push(position);
      const marker = L.marker(position, { icon: markerIcon(r.type), title: r.category }).addTo(map);
      const service = r.type === 'em' && r.emergency_service ? `<br><small>Servicio: ${esc(r.emergency_service)}</small>` : '';
      marker.bindPopup(`<strong>${esc(r.category)}</strong>${service}<br>${esc(r.description || 'Sin descripción')}<br><small>${esc(r.address || 'Sin dirección')}</small>`);
      if (!pick) marker.on('click', () => { S.sel = r.id; render(); });
      if (!pick && S.sel === r.id) marker.openPopup();
    });
    if (pick) {
      pickMap = map;
      pickLayer = L.layerGroup().addTo(map);
      drawPick(false);
      map.on('click', e => setPick(e.latlng.lat, e.latlng.lng, false));
    } else if (markerBounds.length > 1) {
      map.fitBounds(markerBounds, { padding: [28, 28], maxZoom: 14 });
    }
    window.setTimeout(() => map.invalidateSize(), 0);
  });
}

/* ---------- cascarón ---------- */
const icons = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'
};
const ico = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[k]}</svg>`;

function shell(route, body) {
  const on = r => route === r ? 'on' : '';
  const who = S.user ? `<a class="ava" href="/perfil" title="Ver perfil de ${esc(S.user.email)}" aria-label="Ver mi perfil">${esc(S.user.email[0].toUpperCase())}</a>` : '<a class="btn pr sm" href="/ingresar">Ingresar</a>';
  return `<header><div class="bar"><a class="logo" href="/"><img src="/logo-calle-segura.png" alt="Calle Segura"><span>Calle Segura</span></a>
    <nav aria-label="Principal"><a class="${on('')}" href="/">Inicio</a><a class="${on('mapa')}" href="/mapa">Mapa</a><a class="${on('reportar')}" href="/reportar">Reportar</a></nav>${who}</div></header>
    <main class="view">${body}</main>`;
}
function muniShell(route, body) {
  const on = r => route === r ? 'on' : '';
  const nuevos = S.reports.filter(r => r.status === 'Nuevo').length;
  return `<div class="muni"><nav class="rail" aria-label="Navegación municipal">
    <a class="lg" href="/muni"><img src="/logo-calle-segura.png" alt=""><span>Calle Segura</span></a>
    <a class="${on('muni')}" href="/muni" title="Resumen">${ico('grid')}<span>Resumen</span></a>
    <a class="${on('muni/reportes')}" href="/muni/reportes" title="Reportes">${ico('list')}<span>Reportes</span>${nuevos ? `<span class="badge">${nuevos}</span>` : ''}</a>
    <a class="${on('muni/usuarios')}" href="/muni/usuarios" title="Usuarios">${ico('users')}<span>Usuarios</span></a>
    <a class="out" href="/salir" title="Salir" aria-label="Cerrar sesión">${ico('out')}<span>Cerrar sesión</span></a></nav>
    <div class="mmain view">${body}</div></div>`;
}

/* ---------- vistas ciudadano ---------- */
function stats(list) {
  const n = f => list.filter(f).length;
  return `<div class="stats"><div class="dk"><b>${list.length}</b><span>Reportes</span></div><div><b>${n(r => r.type === 'em')}</b><span>Emergencias</span></div><div><b>${n(r => r.type === 'pr')}</b><span>Problemas</span></div><div><b>${n(r => r.status === 'Resuelto')}</b><span>Resueltos</span></div></div>`;
}
function vInicio() {
  const passkeyAction = S.user ? '<button class="btn ghost" type="button" id="register-passkey">🔐 Activar huella</button>' : '';
  const welcomePanel = S.user
    ? `<div class="herocard">${mapHTML('all')}</div>`
    : `<div class="hero-access box"><div class="access-icon">⌖</div><h3>Ingresa para continuar</h3><p>Para ver el mapa y reportar una situación necesitas iniciar sesión.</p><a class="btn pr full" href="/ingresar">Ingresar ahora</a><small>Acceso con correo y contraseña</small></div>`;
  return `<section class="hero"><div><h1>Tu calle, <em>más segura</em> entre todos.</h1>
    <p class="lead">Reporta emergencias y problemas de tu barrio en segundos y sigue cómo la municipalidad responde.</p>
    <div class="row"><a class="btn em" href="/reportar">Reportar ahora</a><a class="btn ghost" href="/mapa">Ver el mapa</a>${passkeyAction}</div>
    <div class="sos"><b>¿Emergencia en curso?</b> Llama primero al 133 (Carabineros), 132 (Bomberos) o 131 (Ambulancia).</div></div>
    ${welcomePanel}</section>
    ${stats(S.reports)}
    <h2>Así funciona</h2><div class="steps">
    <div class="box"><div class="n">1</div><h3>Marca el lugar</h3><p>Toca el mapa donde ocurre lo que quieres reportar.</p></div>
    <div class="box"><div class="n">2</div><h3>Cuéntanos qué pasa</h3><p>Elige si es emergencia o problema y describe brevemente.</p></div>
    <div class="box"><div class="n">3</div><h3>Sigue el estado</h3><p>Nuevo, visto, en curso o resuelto: lo ves en el mapa.</p></div></div>`;
}
function reportCard(r) {
  const service = r.type === 'em' && r.emergency_service ? `<small>Servicio: ${esc(r.emergency_service)}</small>` : '';
  return `<div class="card" data-card="${r.id}"><div class="top"><div>${tag(r)}</div><small>${ago(r.created_at)}</small></div><h3>${esc(r.category)}</h3>${service}<p>${esc(r.description || 'Sin descripción')}</p><small>${esc(r.address || 'Sin dirección')}</small></div>`;
}
function vMapa() {
  if (!S.user) return `<div class="auth box"><h2>Ingresa para reportar</h2><p class="hint">Inicia sesión para ver el mapa y gestionar tus reportes.</p><a class="btn full" style="margin-top:14px" href="/ingresar">Ingresar</a></div>`;
  const list = S.reports.filter(r => S.filter === 'all' || r.type === S.filter);
  const seg = [['all', 'Todos'], ['em', 'Emergencias'], ['pr', 'Problemas']].map(([k, l]) => `<button class="${S.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('');
  const shown = S.sel ? list.filter(r => r.id === S.sel) : list;
  const reportAction = S.user
    ? '<a class="btn pr" href="/reportar">Crear reporte</a>'
    : '<div class="map-login"><p class="hint">Para reportar necesitas ingresar.</p><a class="btn pr" href="/ingresar">Ingresa para reportar</a></div>';
  return `<h2>Mapa de <em>reportes</em></h2><div class="seg" role="group" aria-label="Filtro">${seg}</div>
    <div class="two"><div class="box">${mapHTML('filtered')}<p class="hint">Toca un pin para ver el detalle${S.sel ? ' · <a href="/mapa" data-clear>quitar selección</a>' : ''}.</p>${reportAction}</div>
    <div>${shown.map(reportCard).join('') || '<p class="hint">No hay reportes.</p>'}${S.tracking ? `<div class="box" style="margin-top:16px"><b>Seguimiento de emergencia activo</b><p class="hint">Tu ubicación se comparte mientras esta página permanezca abierta.</p><button class="btn ghost" type="button" data-stop-tracking>Detener seguimiento</button></div>` : ''}</div></div>`;
}
function vReportar() {
  if (!S.user) return `<div class="auth box"><h2>Ingresa para reportar</h2><p class="hint">Necesitas una cuenta para que podamos hacer seguimiento.</p><a class="btn full" style="margin-top:14px" href="/ingresar">Ingresar</a></div>`;
  const f = S.form;
  const categories = S.type === 'em' ? (CATS.em[f.service || 'Carabineros'] || CATS.em.Carabineros) : CATS.pr;
  return `<h2>Nuevo <em>reporte</em></h2><div class="two"><form class="box" id="rform" novalidate>
    <label>Tipo</label><div class="types"><button type="button" class="em ${S.type === 'em' ? 'on' : ''}" data-type="em">🚨 Emergencia</button><button type="button" class="pr ${S.type === 'pr' ? 'on' : ''}" data-type="pr">🛠 Problema</button></div>
    <label for="cat">Categoría</label><select id="cat">${categories.map(c => `<option ${c === f.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <input id="customcat" value="${esc(f.customCat || '')}" placeholder="Escribe la categoría" maxlength="80" hidden>
    <label id="service-label" for="service">Compañía o servicio de emergencia</label><select id="service">${SERVICES.map(service => `<option ${service === (f.service || 'Carabineros') ? 'selected' : ''}>${service}</option>`).join('')}</select>
    <label for="desc">Descripción (opcional)</label><textarea id="desc" placeholder="Agrega detalles si los tienes">${esc(f.desc || '')}</textarea>
    <label for="addr">Dirección o referencia</label><input id="addr" value="${esc(f.addr || '')}" placeholder="Ej: Calle Prat con Calle Lira">
    <label class="hint"><input id="track-location" type="checkbox" ${f.track ? 'checked' : ''}> Si es un robo o asalto, compartir mi ubicación en vivo mientras la página esté abierta.</label>
    <button class="btn full ${S.type}" style="margin-top:18px" type="submit">Enviar reporte</button></form>
    <div class="box"><h3>Marca la ubicación</h3><button type="button" class="btn gps" id="usegps">⌖ Usar mi ubicación</button>${mapHTML('picker')}<p class="hint" id="pickhint">${S.pick ? 'Ubicación marcada ✓' : 'Usa el GPS o toca el mapa para marcar dónde ocurre.'}</p></div></div>`;
}
function setCustomCategory() {
  const select = $('#cat'), input = $('#customcat');
  if (!select || !input) return;
  const custom = select.value === 'Otro';
  input.hidden = !custom;
  input.required = custom;
  if (!custom) input.value = '';
}
function setEmergencyService() {
  const label = $('#service-label'), select = $('#service');
  if (!label || !select) return;
  const visible = S.type === 'em';
  label.hidden = !visible;
  select.hidden = !visible;
  select.required = visible;
}
function setCategoryOptions(selected = '') {
  const select = $('#cat');
  if (!select) return;
  const service = $('#service')?.value || 'Carabineros';
  const categories = S.type === 'em' ? (CATS.em[service] || CATS.em.Carabineros) : CATS.pr;
  const chosen = categories.includes(selected) ? selected : categories[0];
  select.innerHTML = categories.map(category => `<option ${category === chosen ? 'selected' : ''}>${category}</option>`).join('');
}
function saveReportForm() {
  S.form = { desc: $('#desc')?.value || '', addr: $('#addr')?.value || '', customCat: $('#customcat')?.value || '', service: $('#service')?.value || '', category: $('#cat')?.value || '', track: $('#track-location')?.checked || false };
}
function useGps() {
  if (!navigator.geolocation) { toast('Este navegador no permite usar GPS'); return; }
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    if (location.hostname === 'calle-segura') {
      toast('Abriendo una dirección compatible con ubicación…');
      window.setTimeout(() => { window.location.href = `http://localhost${location.pathname}${location.search}${location.hash}`; }, 500);
      return;
    }
    toast('La ubicación requiere abrir este sitio mediante HTTPS');
    return;
  }
  const button = $('#usegps');
  if (button) { button.disabled = true; button.textContent = 'Buscando ubicación…'; }
  navigator.geolocation.getCurrentPosition(position => {
    setPick(position.coords.latitude, position.coords.longitude, true);
    if (button) { button.disabled = false; button.textContent = '⌖ Usar mi ubicación'; }
    toast('Ubicación encontrada');
  }, error => {
    if (button) { button.disabled = false; button.textContent = '⌖ Usar mi ubicación'; }
    const message = error.code === 1 ? 'Permite el acceso a la ubicación' : error.code === 2 ? 'No se pudo encontrar tu ubicación' : 'El GPS tardó demasiado';
    toast(message);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function stopLiveTracking(showMessage = true) {
  if (S.tracking?.watchId != null) navigator.geolocation.clearWatch(S.tracking.watchId);
  S.tracking = null;
  if (showMessage) toast('Seguimiento de ubicación detenido');
}
function startLiveTracking(reportId) {
  if (!navigator.geolocation) { toast('Este navegador no permite seguimiento GPS'); return; }
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    toast('El seguimiento requiere abrir el sitio mediante HTTPS');
    return;
  }
  stopLiveTracking(false);
  S.tracking = { reportId, watchId: null, lastSentAt: 0, announced: false };
  const sendPosition = async position => {
    const tracking = S.tracking;
    if (!tracking || tracking.reportId !== reportId) return;
    const now = Date.now();
    if (now - tracking.lastSentAt < 15000) return;
    tracking.lastSentAt = now;
    try {
      await api(`/api/reports/${reportId}/location`, { method: 'POST', body: { latitude: position.coords.latitude, longitude: position.coords.longitude } });
      if (!tracking.announced) { tracking.announced = true; toast('Seguimiento activo: compartiendo ubicación cada 15 segundos'); }
    } catch (error) {
      stopLiveTracking(false);
      toast(error.message);
    }
  };
  S.tracking.watchId = navigator.geolocation.watchPosition(sendPosition, () => {
    stopLiveTracking(false);
    toast('No se pudo continuar el seguimiento de ubicación');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}
function vLogin() {
  return `<form class="auth box" id="lform"><div class="auth-brand"><img src="/logo-calle-segura.png" alt="Calle Segura"><span>Acceso seguro a tu comunidad</span></div><h2>Ingresar a <em>Calle Segura</em></h2><p class="hint">Accede con tu correo y contraseña.</p>
    <label for="em">Correo</label><input id="em" type="email" autocomplete="email" placeholder="vecina@correo.cl" required>
    <label for="pw">Contraseña</label><input id="pw" type="password" autocomplete="current-password" minlength="8" required>
    <button class="btn full" style="margin-top:18px" type="submit">Entrar</button>
    <button class="btn full biometric" type="button" id="passkey-login">🔐 Entrar con huella</button>
    <p class="hint" style="margin-top:12px">¿No tienes cuenta? <a href="/registrar">Crear una cuenta</a></p>
    <p class="hint">Personal municipal: ingresa con las credenciales asignadas.</p></form>`;
}
function vPerfil() {
  if (!S.user) return `<div class="auth box"><h2>Ingresa para ver tu perfil</h2><a class="btn full" style="margin-top:14px" href="/ingresar">Ingresar</a></div>`;
  const role = S.user.role === 'admin' ? 'Administrador/a' : S.user.role === 'staff' ? 'Funcionario/a municipal' : 'Vecino/a';
  const name = S.user.full_name || S.user.email.split('@')[0];
  return `<section class="profile box"><div class="profile-avatar" aria-hidden="true">${esc(name[0].toUpperCase())}</div><div><p class="hint">Mi perfil</p><h2>${esc(name)}</h2><dl><div><dt>Correo</dt><dd>${esc(S.user.email)}</dd></div><div><dt>Tipo de cuenta</dt><dd>${role}</dd></div></dl><a class="btn full logout" href="/salir">Cerrar sesion</a></div></section>`;
}
function vRegister() {
  return `<form class="auth box" id="regform"><div class="auth-brand"><img src="/logo-calle-segura.png" alt="Calle Segura"><span>Únete a tu comunidad</span></div><h2>Crear <em>cuenta</em></h2><p class="hint">Regístrate para reportar y seguir situaciones de tu barrio.</p>
    <label for="reg-name">Nombre</label><input id="reg-name" type="text" autocomplete="name" maxlength="120" placeholder="Tu nombre" required>
    <label for="reg-em">Correo</label><input id="reg-em" type="email" autocomplete="email" placeholder="vecina@correo.cl" required>
    <label for="reg-pw">Contraseña</label><input id="reg-pw" type="password" autocomplete="new-password" minlength="8" required>
    <button class="btn full" style="margin-top:18px" type="submit">Crear cuenta</button>
    <p class="hint" style="margin-top:12px">¿Ya tienes cuenta? <a href="/ingresar">Ingresar</a></p></form>`;
}

/* ---------- portal municipal ---------- */
function mResumen() {
  const c = s => S.reports.filter(r => r.status === s).length, max = Math.max(1, ...STATUSES.map(c));
  const nuevos = S.reports.filter(r => r.status === 'Nuevo' || r.type === 'em' && r.status !== 'Resuelto').slice(0, 4);
  return `<div class="banner"><div><h1>Panel <em>municipal</em></h1><p>${S.reports.filter(r => r.status === 'Nuevo').length} reportes nuevos esperan revisión.</p></div><a class="btn pr" href="/muni/reportes">Gestionar reportes</a></div>
    ${stats(S.reports)}
    <div class="grid2"><div class="box"><h3>Reportes por estado</h3><div class="bars">${STATUSES.map(s => `<div><b>${c(s)}</b><i style="height:${c(s) / max * 100}%"></i>${s}</div>`).join('')}</div></div>
    <div class="box"><h3>Requieren atención</h3>${nuevos.map(reportCard).join('') || '<p class="hint">Todo al día 🎉</p>'}</div></div>
    <div class="box" style="margin-top:16px"><h3>Mapa</h3>${mapHTML('all')}</div>`;
}
function mReportes() {
  return `<h2>Reportes</h2><p class="hint">Cambia el estado para que los vecinos vean el avance.</p><div class="scroll"><table><thead><tr><th>Tipo</th><th>Categoría</th><th>Descripción</th><th>Ubicación</th><th>Hace</th><th>Estado</th></tr></thead><tbody>
    ${S.reports.map(r => `<tr><td><span class="tag t-${r.type}">${r.type === 'em' ? 'Emergencia' : 'Problema'}</span></td><td>${esc(r.category)}${r.type === 'em' && r.emergency_service ? `<br><small class="hint">${esc(r.emergency_service)}</small>` : ''}</td><td>${esc(r.description || 'Sin descripción')}</td><td>${esc(r.address || 'Sin dirección')}<br><a class="hint" href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(r.latitude)}&mlon=${encodeURIComponent(r.longitude)}#map=18/${encodeURIComponent(r.latitude)}/${encodeURIComponent(r.longitude)}" target="_blank" rel="noopener">Ver en mapa</a></td><td>${ago(r.created_at)}</td>
    <td><select data-status="${r.id}" aria-label="Estado">${STATUSES.map(s => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`;
}
function mUsuarios() {
  return `<h2>Usuarios</h2><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Correo</th><th>Rol</th><th>Reportes</th><th></th></tr></thead><tbody>
    ${S.users.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.reports}</td><td>${u.role === 'citizen' ? `<button class="blk ${u.is_blocked ? 'un' : ''}" data-block="${u.id}" data-to="${u.is_blocked ? 0 : 1}">${u.is_blocked ? 'Desbloquear' : 'Bloquear'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------- router ---------- */
function routeFromLocation() {
  if (location.hash.startsWith('#/')) {
    history.replaceState({}, '', location.hash.slice(1) || '/');
  }
  return location.pathname.replace(/^\/+|\/+$/g, '');
}
function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  return render();
}
let lastRoute = null;
async function render() {
  const route = routeFromLocation();
  if (route === 'salir') {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    S.user = null; localStorage.removeItem('cs_user'); history.replaceState({}, '', '/'); return render();
  }
  S.reports = [];
  if (S.user) {
    try { S.reports = await api('/api/reports'); } catch (error) {
      if (error.status === 401 || error.status === 403) {
        S.user = null;
        localStorage.removeItem('cs_user');
        if (route !== 'ingresar') { return go('/ingresar', true); }
      } else {
        toast(error.message);
      }
    }
  }
  const app = $('#app');
  if (route.startsWith('muni')) {
    if (!isStaff()) { return go('/ingresar', true); }
    if (route === 'muni/usuarios') try { S.users = await api('/api/users?email=' + encodeURIComponent(S.user.email)); } catch (e) { toast(e.message); }
    app.innerHTML = muniShell(route, route === 'muni/reportes' ? mReportes() : route === 'muni/usuarios' ? mUsuarios() : mResumen());
  } else {
    const v = { '': vInicio, mapa: vMapa, reportar: vReportar, perfil: vPerfil, ingresar: vLogin, registrar: vRegister }[route] || vInicio;
    app.innerHTML = shell(route, v());
    if (route === 'reportar') { setEmergencyService(); setCategoryOptions(S.form.category); setCustomCategory(); }
  }
  initMaps();
  document.querySelectorAll('#passkey-login, #register-passkey').forEach(button => button.remove());
  if (route !== lastRoute) window.scrollTo(0, 0);
  lastRoute = route;
}

/* ---------- eventos ---------- */
document.addEventListener('click', async e => {
  const t = e.target;
  const link = t.closest('a[href]');
  if (link && link.origin === location.origin && link.getAttribute('href').startsWith('/')) {
    e.preventDefault();
    if (link.matches('[data-clear]')) S.sel = null;
    go(link.pathname);
    return;
  }
  const pin = t.closest('[data-pin]');
  if (pin) { S.sel = +pin.dataset.pin; render(); return; }
  if (t.closest('[data-clear]')) { S.sel = null; }
  const fl = t.closest('[data-filter]');
  if (fl) { S.filter = fl.dataset.filter; S.sel = null; render(); return; }
  const ty = t.closest('[data-type]');
  if (ty) {
    saveReportForm();
    S.type = ty.dataset.type;
    document.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('on', b === ty));
    $('#rform button[type=submit]').className = 'btn full ' + S.type;
    setEmergencyService();
    setCategoryOptions();
    setCustomCategory();
    return;
  }
  if (t.closest('[data-stop-tracking]')) { stopLiveTracking(); render(); return; }
  if (t.closest('#usegps')) { useGps(); return; }
  const bl = t.closest('[data-block]');
  if (bl) {
    try { await api(`/api/users/${bl.dataset.block}/block`, { method: 'POST', body: { email: S.user.email, blocked: +bl.dataset.to } }); toast('Usuario actualizado'); render(); } catch (err) { toast(err.message); }
  }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'service') { saveReportForm(); setCategoryOptions(); setCustomCategory(); return; }
  if (e.target.id === 'cat') { saveReportForm(); setCustomCategory(); return; }
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  try { await api(`/api/reports/${sel.dataset.status}/status`, { method: 'POST', body: { email: S.user.email, status: sel.value } }); toast('Estado actualizado'); render(); } catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'lform') {
    try {
      S.user = await api('/api/login', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value } });
      localStorage.setItem('cs_user', JSON.stringify(S.user));
      toast('Bienvenida/o, ' + (S.user.full_name || S.user.email));
      go(isStaff() ? '/muni' : '/', true);
    } catch (err) { toast(err.message); }
  }
  if (e.target.id === 'regform') {
    try {
      S.user = await api('/api/register', { method: 'POST', body: { full_name: $('#reg-name').value, email: $('#reg-em').value, password: $('#reg-pw').value } });
      localStorage.setItem('cs_user', JSON.stringify(S.user));
      toast('Cuenta creada correctamente');
      go('/', true);
    } catch (err) { toast(err.message); }
  }
  if (e.target.id === 'rform') {
    if (!S.pick) { toast('Marca la ubicación en el mapa'); return; }
    const category = $('#cat').value === 'Otro' ? $('#customcat').value.trim() : $('#cat').value;
    if (!category) { toast('Escribe la categoría'); return; }
    try {
      const service = S.type === 'em' ? $('#service').value : '';
      const created = await api('/api/reports', { method: 'POST', body: { email: S.user.email, type: S.type, category, emergency_service: service, description: $('#desc').value, address: $('#addr').value, latitude: S.pick.lat, longitude: S.pick.lon } });
      if (S.type === 'em' && category === 'Robo o asalto' && $('#track-location').checked) startLiveTracking(created.id);
      S.pick = null; S.form = {}; toast('Reporte enviado. ¡Gracias!'); go('/mapa');
    } catch (err) { toast(err.message); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest?.('[data-pin]')) e.target.closest('[data-pin]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
window.addEventListener('popstate', render);
render().finally(() => setTimeout(() => $('#splash').classList.add('off'), 900));
})();
