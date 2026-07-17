(function(){
  const TIPO_ICONS = {};
  let jornadas = [];
  let asistentesTemp = [];
  let fotosTemp = []; // { dataUrl, base64, mimeType, nombre }
  let driveState = { conectado:false, correo:'', ultimaSync:null };
  let sincronizando = false;

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
    $('#form-msg').textContent = '';
    $('#btn-guardar').disabled = true;
    $('#btn-guardar').textContent = 'Registrando...';

    const jornada = {
      fecha,
      tipo,
      lugar,
      responsable,
      descripcion,
      asistentes: asistentesFinal,
      evidencias: fotosTemp.map(f => ({ data: f.base64, mimeType: f.mimeType, nombre: f.nombre })),
    };

    try {
      const response = await fetch('/api/jornadas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jornada)
      });

      if (!response.ok) {
        // Si la respuesta NO fue exitosa, intentamos leer el mensaje de error del servidor.
        const errorResult = await leerRespuesta(response);
        throw new Error(errorResult.message || 'Ocurrió un error desconocido en el servidor.');
      }
      
      // Si la respuesta FUE exitosa, continuamos.
      mostrarSello();
      await cargarJornadas(); // Recargamos la lista para ver el nuevo registro.
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
    renderAsistentes();
    renderFotos();
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
        <button class="btn-del" data-del="${j.id}" title="Eliminar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6h12z"/></svg>
        </button>
      </div>
    </div>`;
  }
  function escapeHtml(s){
    return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render(){
    // stats
    $('#stat-jornadas').textContent = jornadas.length;
    // Ya no tenemos estos datos directamente, mostramos 'N/A'
    $('#stat-asistentes').textContent = 'N/A';

    // inicio: últimas 5
    const inicioList = $('#inicio-list');
    const recientes = jornadas.slice(0,5);
    inicioList.innerHTML = recientes.length ? recientes.map(hojaHTML).join('') : emptyStateHTML('inicio');

    // historial completo
    const histList = $('#historial-list');
    histList.innerHTML = jornadas.length ? jornadas.map(hojaHTML).join('') : emptyStateHTML('historial');

    // listeners
    $$('.hoja[data-open-link]').forEach(el=>{
      el.addEventListener('click', (e)=>{
        if(e.target.closest('[data-del]')) return;
        // Abrimos el enlace del documento en una nueva pestaña.
        window.open(el.dataset.openLink, '_blank');
      });
    });
    $$('[data-del]').forEach(b=>{
      b.addEventListener('click', (e)=>{ e.stopPropagation(); eliminarJornada(b.dataset.del); });
    });
  }

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