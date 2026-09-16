requireSession();

const tenant = getTenant();
if (tenant) document.querySelector('#tenantName').textContent = tenant.name;

const currentUser = JSON.parse(localStorage.getItem('dinamikus_user') || 'null');
const isAdmin = currentUser && currentUser.role === 'admin';

document.querySelector('#logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

const DIAS = [
  { key: 'lunes', label: 'Lunes' },
  { key: 'martes', label: 'Martes' },
  { key: 'miercoles', label: 'Miércoles' },
  { key: 'jueves', label: 'Jueves' },
  { key: 'viernes', label: 'Viernes' },
  { key: 'sabado', label: 'Sábado' },
  { key: 'domingo', label: 'Domingo' }
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// --- Horario: filas reutilizables (horario general y horario por sede) ---

function horarioRowsHtml() {
  return DIAS.map(
    (d) => `
    <div class="horario-row" data-day="${d.key}">
      <label><input type="checkbox" class="dia-check"> ${d.label}</label>
      <input type="time" class="dia-inicio" value="08:00">
      <span class="separador">a</span>
      <input type="time" class="dia-fin" value="17:00">
    </div>`
  ).join('');
}

function renderHorario(container, horario) {
  container.innerHTML = horarioRowsHtml();
  container.querySelectorAll('.horario-row').forEach((row) => {
    const day = row.dataset.day;
    const rango = horario && horario[day];
    const check = row.querySelector('.dia-check');
    const inicio = row.querySelector('.dia-inicio');
    const fin = row.querySelector('.dia-fin');
    if (rango && rango.length === 2) {
      check.checked = true;
      inicio.value = rango[0];
      fin.value = rango[1];
    } else {
      check.checked = false;
    }
    if (!isAdmin) {
      check.disabled = true;
      inicio.disabled = true;
      fin.disabled = true;
    }
  });
}

function readHorario(container) {
  const horario = {};
  container.querySelectorAll('.horario-row').forEach((row) => {
    const day = row.dataset.day;
    const check = row.querySelector('.dia-check');
    if (check.checked) {
      const inicio = row.querySelector('.dia-inicio').value;
      const fin = row.querySelector('.dia-fin').value;
      horario[day] = [inicio, fin];
    }
  });
  return horario;
}

function applyReadOnly() {
  if (isAdmin) return;
  document.querySelector('#readOnlyNotice').style.display = 'block';
  document.querySelectorAll('input, select, textarea, button').forEach((el) => {
    if (el.id === 'logoutLink') return;
    el.disabled = true;
  });
}

// --- Configuración general + horario ---

let botConfigCache = null;

async function loadBotConfig() {
  const r = await authFetch('/api/bot/config');
  const config = await r.json();
  botConfigCache = config;

  document.querySelector('#activoToggle').checked = config.activo;
  document.querySelector('#nombreNegocio').value = config.nombre_negocio || '';
  document.querySelector('#direccion').value = config.direccion || '';
  document.querySelector('#timezone').value = config.timezone || 'America/El_Salvador';
  document.querySelector('#recordatorio24hToggle').checked = config.recordatorio_24h;
  document.querySelector('#recordatorio2hToggle').checked = config.recordatorio_2h;
  document.querySelector('#recontactoToggle').checked = config.recontacto_no_show;
  document.querySelector('#diasRecontactoInput').value = config.dias_recontacto_no_show;

  renderHorario(document.querySelector('#horarioList'), config.horario_atencion);

  const aviso = document.querySelector('#sinCanalAviso');
  aviso.style.display = config.canalNegocio && config.canalNegocio.status === 'connected' ? 'none' : 'block';
}

async function loadPipelineStages() {
  const r = await authFetch('/api/pipeline-stages');
  const stages = await r.json();
  const select = document.querySelector('#etapaPipeline');
  select.innerHTML =
    '<option value="">No mover de etapa</option>' +
    stages.map((s) => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.label)}</option>`).join('');
  if (botConfigCache) select.value = botConfigCache.appointment_stage_key || '';
}

document.querySelector('#saveBotConfigBtn').addEventListener('click', async () => {
  const btn = document.querySelector('#saveBotConfigBtn');
  const status = document.querySelector('#saveStatus');
  const errorBox = document.querySelector('#botConfigError');
  errorBox.classList.remove('visible');
  btn.disabled = true;
  status.textContent = 'Guardando…';

  try {
    const r = await authFetch('/api/bot/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activo: document.querySelector('#activoToggle').checked,
        nombreNegocio: document.querySelector('#nombreNegocio').value.trim(),
        direccion: document.querySelector('#direccion').value.trim(),
        timezone: document.querySelector('#timezone').value,
        horarioAtencion: readHorario(document.querySelector('#horarioList')),
        appointmentStageKey: document.querySelector('#etapaPipeline').value,
        recordatorio24h: document.querySelector('#recordatorio24hToggle').checked,
        recordatorio2h: document.querySelector('#recordatorio2hToggle').checked,
        recontactoNoShow: document.querySelector('#recontactoToggle').checked,
        diasRecontactoNoShow: parseInt(document.querySelector('#diasRecontactoInput').value, 10) || 2
      })
    });
    const data = await r.json();
    if (!r.ok) {
      errorBox.textContent = data.error || 'No se pudo guardar.';
      errorBox.classList.add('visible');
      status.textContent = '';
      return;
    }
    botConfigCache = { ...botConfigCache, ...data };
    status.textContent = 'Guardado ✓';
    setTimeout(() => (status.textContent = ''), 2500);
  } catch {
    errorBox.textContent = 'Error de conexión al guardar.';
    errorBox.classList.add('visible');
    status.textContent = '';
  } finally {
    btn.disabled = false;
  }
});

// --- Servicios ---

async function loadServicios() {
  const r = await authFetch('/api/bot/services');
  const servicios = await r.json();
  const list = document.querySelector('#serviciosList');

  if (servicios.length === 0) {
    list.innerHTML = '<p class="muted">Aún no has agregado ningún servicio.</p>';
    return;
  }

  list.innerHTML = servicios
    .map((s) => {
      const modalidad =
        s.permite_presencial && s.permite_virtual
          ? 'Presencial y virtual'
          : s.permite_virtual
          ? 'Solo virtual'
          : 'Solo presencial';
      return `
      <div class="list-row">
        <div class="meta">
          <strong>${escapeHtml(s.nombre)}${s.activo ? '' : ' (desactivado)'}</strong>
          <span>${s.duracion_minutos} minutos · ${modalidad}</span>
        </div>
        ${
          isAdmin
            ? `<div class="actions">
                <button class="edit-link" data-id="${s.id}" data-action="edit-servicio">Editar</button>
                <button class="remove-btn" data-id="${s.id}" data-action="delete-servicio">Eliminar</button>
              </div>`
            : ''
        }
      </div>`;
    })
    .join('');

  list.querySelectorAll('[data-action="delete-servicio"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este servicio? El bot dejará de ofrecerlo.')) return;
      await authFetch(`/api/bot/services/${btn.dataset.id}`, { method: 'DELETE' });
      loadServicios();
    });
  });

  list.querySelectorAll('[data-action="edit-servicio"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const servicio = servicios.find((s) => s.id === btn.dataset.id);
      const nuevoNombre = prompt('Nombre del servicio:', servicio.nombre);
      if (nuevoNombre === null) return;
      const nuevaDuracion = prompt('Duración en minutos:', servicio.duracion_minutos);
      if (nuevaDuracion === null) return;
      const presencial = confirm('¿Este servicio se ofrece presencial? Aceptar = sí, Cancelar = no.');
      const virtual = confirm('¿Este servicio se ofrece virtual? Aceptar = sí, Cancelar = no.');
      if (!presencial && !virtual) {
        alert('El servicio debe aceptar presencial, virtual, o ambos — no se guardaron los cambios.');
        return;
      }
      await authFetch(`/api/bot/services/${servicio.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: nuevoNombre.trim(),
          duracionMinutos: parseInt(nuevaDuracion, 10) || servicio.duracion_minutos,
          permitePresencial: presencial,
          permiteVirtual: virtual
        })
      });
      loadServicios();
    });
  });
}

document.querySelector('#nuevoServicioBtn').addEventListener('click', async () => {
  const errorBox = document.querySelector('#servicioError');
  errorBox.classList.remove('visible');
  const nombre = document.querySelector('#nuevoServicioNombre').value.trim();
  const minutos = parseInt(document.querySelector('#nuevoServicioMinutos').value, 10) || 30;
  const presencial = document.querySelector('#nuevoServicioPresencial').checked;
  const virtual = document.querySelector('#nuevoServicioVirtual').checked;

  if (!nombre) {
    errorBox.textContent = 'Escribe un nombre para el servicio.';
    errorBox.classList.add('visible');
    return;
  }

  const r = await authFetch('/api/bot/services', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, duracionMinutos: minutos, permitePresencial: presencial, permiteVirtual: virtual })
  });
  const data = await r.json();
  if (!r.ok) {
    errorBox.textContent = data.error || 'No se pudo agregar el servicio.';
    errorBox.classList.add('visible');
    return;
  }
  document.querySelector('#nuevoServicioNombre').value = '';
  document.querySelector('#nuevoServicioMinutos').value = '30';
  loadServicios();
});

// --- FAQs ---

async function loadFaqs() {
  const r = await authFetch('/api/bot/faqs');
  const faqs = await r.json();
  const list = document.querySelector('#faqsList');

  if (faqs.length === 0) {
    list.innerHTML = '<p class="muted">Aún no has agregado ninguna pregunta frecuente.</p>';
    return;
  }

  list.innerHTML = faqs
    .map(
      (f) => `
      <div class="list-row" style="align-items:flex-start">
        <div class="meta">
          <strong>${escapeHtml(f.pregunta)}${f.activo ? '' : ' (desactivada)'}</strong>
          <span>${escapeHtml(f.respuesta)}</span>
        </div>
        ${
          isAdmin
            ? `<div class="actions">
                <button class="edit-link" data-id="${f.id}" data-action="edit-faq">Editar</button>
                <button class="remove-btn" data-id="${f.id}" data-action="delete-faq">Eliminar</button>
              </div>`
            : ''
        }
      </div>`
    )
    .join('');

  list.querySelectorAll('[data-action="delete-faq"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta pregunta frecuente?')) return;
      await authFetch(`/api/bot/faqs/${btn.dataset.id}`, { method: 'DELETE' });
      loadFaqs();
    });
  });

  list.querySelectorAll('[data-action="edit-faq"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const faq = faqs.find((f) => f.id === btn.dataset.id);
      const nuevaPregunta = prompt('Pregunta:', faq.pregunta);
      if (nuevaPregunta === null) return;
      const nuevaRespuesta = prompt('Respuesta:', faq.respuesta);
      if (nuevaRespuesta === null) return;
      await authFetch(`/api/bot/faqs/${faq.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta: nuevaPregunta.trim(), respuesta: nuevaRespuesta.trim() })
      });
      loadFaqs();
    });
  });
}

document.querySelector('#nuevaFaqBtn').addEventListener('click', async () => {
  const errorBox = document.querySelector('#faqError');
  errorBox.classList.remove('visible');
  const pregunta = document.querySelector('#nuevaFaqPregunta').value.trim();
  const respuesta = document.querySelector('#nuevaFaqRespuesta').value.trim();

  if (!pregunta || !respuesta) {
    errorBox.textContent = 'Completa la pregunta y la respuesta.';
    errorBox.classList.add('visible');
    return;
  }

  const r = await authFetch('/api/bot/faqs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pregunta, respuesta })
  });
  const data = await r.json();
  if (!r.ok) {
    errorBox.textContent = data.error || 'No se pudo agregar la pregunta.';
    errorBox.classList.add('visible');
    return;
  }
  document.querySelector('#nuevaFaqPregunta').value = '';
  document.querySelector('#nuevaFaqRespuesta').value = '';
  loadFaqs();
});

// --- Sedes ---

let ubicacionesCache = [];

async function loadUbicaciones() {
  const r = await authFetch('/api/bot/locations');
  ubicacionesCache = await r.json();
  const list = document.querySelector('#ubicacionesList');

  if (ubicacionesCache.length === 0) {
    list.innerHTML = '<p class="muted">Sin sedes — el bot usa el horario general para todas las citas presenciales.</p>';
    return;
  }

  list.innerHTML = ubicacionesCache
    .map((u) => {
      const dias = DIAS.filter((d) => u.horario_atencion && u.horario_atencion[d.key]);
      const resumenHorario =
        dias.length > 0
          ? dias.map((d) => `${d.label.slice(0, 3)} ${u.horario_atencion[d.key][0]}-${u.horario_atencion[d.key][1]}`).join(', ')
          : 'sin horario configurado';
      return `
      <div class="list-row" style="align-items:flex-start">
        <div class="meta">
          <strong>${escapeHtml(u.nombre)}${u.activo ? '' : ' (desactivada)'}</strong>
          <span>${escapeHtml(u.direccion || '')}${u.nota ? ` · ${escapeHtml(u.nota)}` : ''} · ${resumenHorario}</span>
        </div>
        ${
          isAdmin
            ? `<div class="actions">
                <button class="edit-link" data-id="${u.id}" data-action="edit-sede">Editar</button>
                <button class="remove-btn" data-id="${u.id}" data-action="delete-sede">Eliminar</button>
              </div>`
            : ''
        }
      </div>`;
    })
    .join('');

  list.querySelectorAll('[data-action="delete-sede"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta sede? Si el negocio se queda sin ninguna, vuelve a usar el horario general.')) return;
      await authFetch(`/api/bot/locations/${btn.dataset.id}`, { method: 'DELETE' });
      loadUbicaciones();
    });
  });

  list.querySelectorAll('[data-action="edit-sede"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sede = ubicacionesCache.find((u) => u.id === btn.dataset.id);
      openSedeEditor(sede);
    });
  });
}

function openSedeEditor(sede) {
  const panel = document.querySelector('#sedeEditor');
  document.querySelector('#sedeEditorId').value = sede ? sede.id : '';
  document.querySelector('#sedeEditorNombre').value = sede ? sede.nombre : '';
  document.querySelector('#sedeEditorDireccion').value = sede ? sede.direccion || '' : '';
  document.querySelector('#sedeEditorNota').value = sede ? sede.nota || '' : '';
  document.querySelector('#sedeEditorError').classList.remove('visible');
  renderHorario(document.querySelector('#sedeEditorHorario'), sede ? sede.horario_atencion : {});
  panel.classList.add('visible');
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeSedeEditor() {
  document.querySelector('#sedeEditor').classList.remove('visible');
}

document.querySelector('#agregarSedeBtn').addEventListener('click', () => openSedeEditor(null));
document.querySelector('#sedeEditorCancelarBtn').addEventListener('click', closeSedeEditor);

document.querySelector('#sedeEditorGuardarBtn').addEventListener('click', async () => {
  const errorBox = document.querySelector('#sedeEditorError');
  errorBox.classList.remove('visible');

  const id = document.querySelector('#sedeEditorId').value;
  const nombre = document.querySelector('#sedeEditorNombre').value.trim();
  if (!nombre) {
    errorBox.textContent = 'Escribe un nombre para la sede.';
    errorBox.classList.add('visible');
    return;
  }

  const body = {
    nombre,
    direccion: document.querySelector('#sedeEditorDireccion').value.trim(),
    nota: document.querySelector('#sedeEditorNota').value.trim(),
    horarioAtencion: readHorario(document.querySelector('#sedeEditorHorario'))
  };

  const r = await authFetch(id ? `/api/bot/locations/${id}` : '/api/bot/locations', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) {
    errorBox.textContent = data.error || 'No se pudo guardar la sede.';
    errorBox.classList.add('visible');
    return;
  }
  closeSedeEditor();
  loadUbicaciones();
});

// --- Carga inicial ---

async function init() {
  await loadBotConfig();
  await Promise.all([loadPipelineStages(), loadServicios(), loadFaqs(), loadUbicaciones()]);
  applyReadOnly();
}

init();
