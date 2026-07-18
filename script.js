(function(){
  const TIPO_ICONS = {};
  let jornadas = [];
  let asistentesTemp = [];
  let fotosTemp = []; // { dataUrl, base64, mimeType, nombre } — fotos NUEVAS a subir
  let fotosExistentes = []; // { fileId, nombre } — fotos que YA estaban en Drive (modo edición)
  let fotosAEliminar = []; // fileIds de fotosExistentes que el usuario quitó
  let editandoId = null; // id del documento que se está editando, o null si es una jornada nueva
  let driveState = { conectado:false, correo:'', ultimaSync:null };
  let sincronizando = false;
  let filtros = { texto:'', tipo:'', desde:'', hasta:'' };

  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));

  // Lee la respuesta como texto primero y solo intenta parsear JSON si hay contenido.
  // Evita el error "Unexpected end of JSON input" cuando el servidor responde vacío
  // (caído, timeout de un proxy, etc.) y muestra algo útil en su lugar.
  async function leerRespuesta(response){
    const texto = await response.text();
    if(!texto){
      return { message: `El servidor respondió sin contenido (status ${response.status}). Revisa la consola del backend.` };
    }
    try{
      return JSON.parse(texto);
    }catch(e){
      console.error('Respuesta no era JSON:', texto);
      return { message: `Respuesta inesperada del servidor (status ${response.status}). Revisa la consola del backend.` };
    }
  }

  /* ---------- Persistencia ---------- */
  async function cargarJornadas(){
    try{
      const response = await fetch('/api/jornadas');
      const data = await leerRespuesta(response);
      if (!response.ok) throw new Error(data.message || 'No se pudieron cargar las jornadas desde Drive.');
      jornadas = data;
    }catch(e){
      jornadas = [];
      console.error(e);
    }
    try{
      // La configuración de Drive la mantenemos local por ahora.
      const res2 = await window.storage.get('drive_state', false);
      driveState = res2 && res2.value ? JSON.parse(res2.value) : { conectado:false, correo:'', ultimaSync:null };
    }catch(e){
      driveState = { conectado:false, correo:'', ultimaSync:null };
    }
    render();
    // La pestaña Drive ya no es relevante para la sincronización.
  }
  // Ya no guardaremos jornadas localmente.
  // async function guardarJornadas(){
  //   // ...
  // }

  async function guardarDriveState(){
    try{
      await window.storage.set('drive_state', JSON.stringify(driveState), false);
    }catch(e){
      console.error('No se pudo guardar el estado de Drive', e);
    }
  }

  /* ---------- Navegación por pestañas ---------- */
  $$('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> switchTab(btn.dataset.tab));
  });
  function switchTab(tab){
    $$('.tab-btn').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
    $$('.panel').forEach(p=> p.classList.toggle('active', p.id==='panel-'+tab));
  }

  /* ---------- Asistentes dinámicos ---------- */
  function renderAsistentes(){
    const wrap = $('#asistentes-wrap');
    wrap.innerHTML = '';
    asistentesTemp.forEach((a, i)=>{
      const row = document.createElement('div');
      row.className = 'asistente-row';
      row.innerHTML = `
        <div class="field" style="margin-bottom:0">
          <label>Nombre</label>
          <input type="text" data-i="${i}" data-f="nombre" value="${a.nombre.replace(/"/g,'&quot;')}" placeholder="Nombre completo">
        </div>
        <div class="field" style="margin-bottom:0">
          <label>Cédula (opcional)</label>
          <input type="text" data-i="${i}" data-f="cedula" value="${a.cedula.replace(/"/g,'&quot;')}" placeholder="N.º documento">
        </div>
        <button class="icon-btn" data-rm="${i}" title="Quitar asistente">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
      wrap.appendChild(row);
    });
    $('#asis-count').textContent = asistentesTemp.length;
    $$('#asistentes-wrap input').forEach(inp=>{
      inp.addEventListener('input', e=>{
        const i = +e.target.dataset.i, f = e.target.dataset.f;
        asistentesTemp[i][f] = e.target.value;
      });
    });
    $$('#asistentes-wrap [data-rm]').forEach(b=>{
      b.addEventListener('click', ()=>{
        asistentesTemp.splice(+b.dataset.rm, 1);
        renderAsistentes();
      });
    });
  }
  $('#btn-add-asistente').addEventListener('click', ()=>{
    asistentesTemp.push({nombre:'', cedula:''});
    renderAsistentes();
  });

  /* ---------- Fotos de evidencia ---------- */
  const MAX_FOTOS = 6;
  const MAX_MB_POR_FOTO = 5;

  function renderFotos(){
    const wrap = $('#thumbs-wrap');
    wrap.innerHTML = '';
    fotosTemp.forEach((f, i)=>{
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `
        <img src="${f.dataUrl}" alt="${escapeHtml(f.nombre)}">
        <button class="rm" data-rmfoto="${i}" title="Quitar foto">✕</button>`;
      wrap.appendChild(div);
    });
    $('#fotos-count').textContent = fotosTemp.length;
    $$('#thumbs-wrap [data-rmfoto]').forEach(b=>{
      b.addEventListener('click', ()=>{
        fotosTemp.splice(+b.dataset.rmfoto, 1);
        renderFotos();
      });
    });
  }

  function agregarArchivos(fileList){
    const archivos = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    for(const file of archivos){
      if(fotosTemp.length >= MAX_FOTOS){
        alert(`Máximo ${MAX_FOTOS} fotos por jornada.`);
        break;
      }
      if(file.size > MAX_MB_POR_FOTO * 1024 * 1024){
        alert(`"${file.name}" pesa más de ${MAX_MB_POR_FOTO}MB, no se agregó.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = (e)=>{
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(',')[1];
        fotosTemp.push({ dataUrl, base64, mimeType: file.type, nombre: file.name });
        renderFotos();
      };
      reader.readAsDataURL(file);
    }
  }

  $('#drop-zone').addEventListener('click', ()=> $('#f-fotos').click());
  $('#f-fotos').addEventListener('change', (e)=>{
    agregarArchivos(e.target.files);
    e.target.value = ''; // permite volver a seleccionar el mismo archivo si se quita y se re-agrega
  });
  $('#drop-zone').addEventListener('dragover', (e)=>{ e.preventDefault(); $('#drop-zone').style.borderColor = 'var(--pine)'; });
  $('#drop-zone').addEventListener('dragleave', ()=>{ $('#drop-zone').style.borderColor = ''; });
  $('#drop-zone').addEventListener('drop', (e)=>{
    e.preventDefault();
    $('#drop-zone').style.borderColor = '';
    agregarArchivos(e.dataTransfer.files);
  });

  /* ---------- Guardar jornada ---------- */
  $('#btn-guardar').addEventListener('click', async ()=>{
    const fecha = $('#f-fecha').value;
    const tipo = $('#f-tipo').value;
    const lugar = $('#f-lugar').value.trim();
    const responsable = $('#f-responsable').value.trim();
    const descripcion = $('#f-desc').value.trim();
    const asistentesFinal = asistentesTemp.filter(a=>a.nombre.trim()!=='');

    if(!fecha || !tipo || !lugar){
      $('#form-msg').textContent = 'Completa fecha, tipo de actividad y lugar.';
      return;
    }
    const esEdicion = !!editandoId;
    $('#form-msg').textContent = '';
    $('#btn-guardar').disabled = true;
    $('#btn-guardar').textContent = esEdicion ? 'Guardando cambios...' : 'Registrando...';

    const jornada = {
      fecha,
      tipo,
      lugar,
      responsable,
      descripcion,
      asistentes: asistentesFinal,
      evidencias: fotosTemp.map(f => ({ data: f.base64, mimeType: f.mimeType, nombre: f.nombre })),
    };
    if (esEdicion) {
      jornada.fotosEliminar = fotosAEliminar;
    }

    try {
      const response = await fetch(esEdicion ? `/api/jornadas/${editandoId}` : '/api/jornadas', {
        method: esEdicion ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jornada)
      });

      if (!response.ok) {
        // Si la respuesta NO fue exitosa, intentamos leer el mensaje de error del servidor.
        const errorResult = await leerRespuesta(response);
        throw new Error(errorResult.message || 'Ocurrió un error desconocido en el servidor.');
      }

      // Si la respuesta FUE exitosa, continuamos.
      if (!esEdicion) mostrarSello();
      await cargarJornadas(); // Recargamos la lista para ver el registro nuevo/actualizado.
      if (esEdicion) switchTab('historial');
    } catch (error) {
      $('#form-msg').textContent = `Error: ${error.message}`;
    } finally {
      $('#btn-guardar').disabled = false;
      $('#btn-guardar').textContent = 'Registrar jornada';
      resetForm(); // Movemos el reseteo del formulario al bloque finally.
    }
  });

  function resetForm(){
    $('#f-fecha').value = '';
    $('#f-tipo').value = '';
    $('#f-lugar').value = '';
    $('#f-responsable').value = '';
    $('#f-desc').value = '';
    asistentesTemp = [{nombre:'', cedula:''}];
    fotosTemp = [];
    fotosExistentes = [];
    fotosAEliminar = [];
    editandoId = null;
    $('#edit-banner').style.display = 'none';
    $('#registrar-title').textContent = 'Datos de la jornada';
    $('#btn-guardar').textContent = 'Registrar jornada';
    renderAsistentes();
    renderFotos();
    renderFotosExistentes();
  }

  /* ---------- Edición de jornadas ---------- */
  async function abrirEdicion(id){
    try{
      const response = await fetch(`/api/jornadas/${id}`);
      const data = await leerRespuesta(response);
      if(!response.ok) throw new Error(data.message || 'No se pudo cargar la jornada para editar.');

      resetForm();
      editandoId = id;
      $('#f-fecha').value = data.fecha || '';
      $('#f-tipo').value = data.tipo || '';
      $('#f-lugar').value = data.lugar || '';
      $('#f-responsable').value = data.responsable || '';
      $('#f-desc').value = data.descripcion || '';
      asistentesTemp = (data.asistentes && data.asistentes.length) ? data.asistentes.map(a=>({nombre:a.nombre||'', cedula:a.cedula||''})) : [{nombre:'', cedula:''}];
      fotosExistentes = Array.isArray(data.fotos) ? data.fotos.slice() : [];
      renderAsistentes();
      renderFotosExistentes();

      $('#edit-banner').style.display = 'flex';
      $('#registrar-title').textContent = `Editando: ${data.tipo || 'jornada'}`;
      $('#btn-guardar').textContent = 'Guardar cambios';
      if(data.legado){
        $('#form-msg').textContent = 'Esta jornada es de antes de tener edición completa: descripción y asistentes quedaron vacíos, pero puedes completarlos ahora.';
      }
      switchTab('registrar');
      window.scrollTo({top:0, behavior:'smooth'});
    }catch(error){
      alert(`No se pudo abrir la jornada para editar: ${error.message}`);
    }
  }

  $('#btn-cancelar-edicion').addEventListener('click', ()=>{
    resetForm();
    switchTab('historial');
  });

  function renderFotosExistentes(){
    const wrap = $('#existentes-wrap');
    wrap.innerHTML = '';
    fotosExistentes.forEach(f=>{
      const chip = document.createElement('div');
      chip.className = 'chip-foto';
      chip.innerHTML = `<span title="${escapeHtml(f.nombre)}">${escapeHtml(f.nombre)}</span><button data-rmexistente="${f.fileId}" title="Quitar foto">✕</button>`;
      wrap.appendChild(chip);
    });
    $$('#existentes-wrap [data-rmexistente]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const fid = b.dataset.rmexistente;
        fotosAEliminar.push(fid);
        fotosExistentes = fotosExistentes.filter(f=>f.fileId !== fid);
        renderFotosExistentes();
      });
    });
  }

  function mostrarSello(){
    const ov = $('#stamp-overlay');
    ov.classList.add('show');
    setTimeout(()=>{
      ov.classList.remove('show');
      switchTab('historial');
    }, 1300);
  }

  /* ---------- Eliminar jornada ---------- */
  async function eliminarJornada(id){
    if(!confirm('¿Eliminar este registro de jornada de Google Drive? Esta acción no se puede deshacer.')) return;
    // TODO: Añadir un indicador visual de que la eliminación está en proceso.
    try {
      const response = await fetch(`/api/jornadas/${id}`, { method: 'DELETE' });

      if (!response.ok) {
        // Si hay un error, el backend envía un JSON con el mensaje. Lo leemos aquí.
        const errorResult = await leerRespuesta(response);
        throw new Error(errorResult.message || 'Error desconocido del servidor.');
      }
      await cargarJornadas(); // Si la respuesta fue 'ok', simplemente recargamos la lista.
    } catch (error) {
      alert(`No se pudo eliminar la jornada: ${error.message}`);
    }
  }

  /* ---------- Render de listas ---------- */
  function fmtFecha(f){
    if(!f) return {dia:'--', mes:'---'};
    const d = new Date(f + 'T00:00:00');
    const dias = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31'];
    const meses = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
    return { dia: String(d.getDate()).padStart(2,'0'), mes: meses[d.getMonth()] };
  }

  function hojaHTML(j){
    const {dia, mes} = fmtFecha(j.fecha);
    // data-open ahora contendrá el enlace directo al documento.
    return `    <div class="hoja" data-open-link="${j.enlace}">
      <div class="fecha-box"><span class="dia">${dia}</span>${mes}</div>
      <div class="info">
        <div class="titulo">${j.titulo}</div>
        <div class="meta">Registrado: ${new Date(j.creado).toLocaleString('es-CO')}</div>
      </div>
      <div class="badges">
        <!-- Los contadores de asistentes/fotos ya no están disponibles directamente, los quitamos -->
        <button class="btn-editar" data-edit="${j.id}" title="Editar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="btn-del" data-del="${j.id}" title="Eliminar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6h12z"/></svg>
        </button>
      </div>
    </div>`;
  }
  function escapeHtml(s){
    return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function actualizarOpcionesFiltroTipo(){
    const sel = $('#filtro-tipo');
    const valorActual = sel.value;
    const tiposUnicos = Array.from(new Set(jornadas.map(j=>j.titulo).filter(Boolean))).sort();
    sel.innerHTML = '<option value="">Todas</option>' + tiposUnicos.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    if(tiposUnicos.includes(valorActual)) sel.value = valorActual;
  }

  function jornadasFiltradas(){
    const texto = filtros.texto.trim().toLowerCase();
    return jornadas.filter(j=>{
      if(filtros.tipo && j.titulo !== filtros.tipo) return false;
      if(filtros.desde && j.fecha && j.fecha < filtros.desde) return false;
      if(filtros.hasta && j.fecha && j.fecha > filtros.hasta) return false;
      if(texto){
        const campos = [j.titulo, j.lugar, j.responsable].join(' ').toLowerCase();
        if(!campos.includes(texto)) return false;
      }
      return true;
    });
  }

  function render(){
    // stats
    $('#stat-jornadas').textContent = jornadas.length;
    // Ya no tenemos estos datos directamente, mostramos 'N/A'
    $('#stat-asistentes').textContent = 'N/A';

    // inicio: últimas 5 (sin filtrar)
    const inicioList = $('#inicio-list');
    const recientes = jornadas.slice(0,5);
    inicioList.innerHTML = recientes.length ? recientes.map(hojaHTML).join('') : emptyStateHTML('inicio');

    // historial: aplicando los filtros activos
    actualizarOpcionesFiltroTipo();
    const filtradas = jornadasFiltradas();
    const histList = $('#historial-list');
    histList.innerHTML = filtradas.length ? filtradas.map(hojaHTML).join('') : emptyStateHTML('historial');

    const hayFiltrosActivos = filtros.texto || filtros.tipo || filtros.desde || filtros.hasta;
    $('#filtro-count').textContent = hayFiltrosActivos
      ? `Mostrando ${filtradas.length} de ${jornadas.length} jornadas`
      : (jornadas.length ? `${jornadas.length} jornada${jornadas.length===1?'':'s'} en total` : '');

    // listeners
    $$('.hoja[data-open-link]').forEach(el=>{
      el.addEventListener('click', (e)=>{
        if(e.target.closest('[data-del]') || e.target.closest('[data-edit]')) return;
        // Abrimos el enlace del documento en una nueva pestaña.
        window.open(el.dataset.openLink, '_blank');
      });
    });
    $$('[data-del]').forEach(b=>{
      b.addEventListener('click', (e)=>{ e.stopPropagation(); eliminarJornada(b.dataset.del); });
    });
    $$('[data-edit]').forEach(b=>{
      b.addEventListener('click', (e)=>{ e.stopPropagation(); abrirEdicion(b.dataset.edit); });
    });
  }

  /* ---------- Filtros del historial ---------- */
  $('#filtro-texto').addEventListener('input', e=>{ filtros.texto = e.target.value; render(); });
  $('#filtro-tipo').addEventListener('change', e=>{ filtros.tipo = e.target.value; render(); });
  $('#filtro-desde').addEventListener('change', e=>{ filtros.desde = e.target.value; render(); });
  $('#filtro-hasta').addEventListener('change', e=>{ filtros.hasta = e.target.value; render(); });
  $('#filtro-limpiar').addEventListener('click', ()=>{
    filtros = { texto:'', tipo:'', desde:'', hasta:'' };
    $('#filtro-texto').value = '';
    $('#filtro-tipo').value = '';
    $('#filtro-desde').value = '';
    $('#filtro-hasta').value = '';
    render();
  });

  function emptyStateHTML(origen){
    return `<div class="empty-state">
      <p>Aún no se han registrado jornadas.${origen==='inicio' ? ' Registra la primera para comenzar el historial de tu JAC.' : ''}</p>
      <button class="add-link" onclick="document.querySelector('[data-tab=registrar]').click()">+ Registrar jornada</button>
    </div>`;
  }

  /* ---------- Detalle ---------- */
  // El detalle ahora se ve directamente en Google Docs, por lo que este overlay ya no es necesario.
  // function abrirDetalle(id){ ... }
  // function cerrarDetalle(){ ... }
  // ...

  /* ---------- Drive (simulado) ---------- */
  // Toda la lógica de la simulación de Drive ha sido eliminada
  // ya que ahora la conexión es real y directa a través del backend.
  /* ---------- Init ---------- */
  resetForm();
  cargarJornadas();
})();