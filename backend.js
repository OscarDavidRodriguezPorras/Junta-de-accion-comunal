const express = require('express');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');

const app = express();
const port = 3000;

// --- Configuración de Google API ---
// Antes se usaba una cuenta de servicio (credentials.json), pero las cuentas de servicio
// no tienen cuota propia de Drive en cuentas personales de Gmail (sin Google Workspace),
// así que la creación de documentos fallaba con "storage quota exceeded".
// Ahora se autentica como tú mismo (OAuth), usando el token generado por authorize.js.
const OAUTH_CREDENTIALS_PATH = path.join(__dirname, 'oauth-credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'];

// ID de la carpeta en Google Drive donde se guardarán las jornadas.
// Para obtenerlo, abre la carpeta en tu navegador y copia la última parte de la URL.
// Ejemplo: https://drive.google.com/drive/folders/1a2b3c4d5e6f7g8h9i0j
const DRIVE_FOLDER_ID = '1j2Fgehy5osQvXP4qCQ_45L1yINmdox1M';

// --- Cargar credenciales: primero de archivo local (desarrollo); si no existe,
// de variables de entorno (Render / producción). Así oauth-credentials.json y
// token.json siguen fuera de Git (.gitignore) pero el backend igual funciona
// en el servidor remoto, pegando su contenido como variables de entorno.
function cargarJSON(rutaArchivo, nombreVarEntorno, descripcionError) {
  if (fs.existsSync(rutaArchivo)) {
    return JSON.parse(fs.readFileSync(rutaArchivo, 'utf8'));
  }
  const valorEnv = process.env[nombreVarEntorno];
  if (valorEnv) {
    try {
      return JSON.parse(valorEnv);
    } catch (e) {
      console.error(`La variable de entorno ${nombreVarEntorno} no contiene JSON válido.`);
      process.exit(1);
    }
  }
  console.error(`Falta ${rutaArchivo} y tampoco existe la variable de entorno ${nombreVarEntorno}. ${descripcionError}`);
  process.exit(1);
}

const oauthKeys = cargarJSON(
  OAUTH_CREDENTIALS_PATH,
  'GOOGLE_OAUTH_CREDENTIALS',
  'Descárgalo desde Google Cloud Console (credenciales OAuth, tipo Aplicación de escritorio) y pega su contenido en esa variable de entorno.'
);
const oauthCreds = oauthKeys.installed || oauthKeys.web;
const auth = new google.auth.OAuth2(oauthCreds.client_id, oauthCreds.client_secret, 'http://localhost:4321');

const savedTokens = cargarJSON(
  TOKEN_PATH,
  'GOOGLE_TOKEN',
  'Corre primero "node authorize.js" en tu máquina y pega el contenido de token.json en esa variable de entorno.'
);
auth.setCredentials(savedTokens);

// Cuando Google renueve el access_token automáticamente, lo volvemos a guardar en disco
// (solo si estamos usando el archivo local; en Render el disco es efímero,
// pero no hay problema porque el refresh_token no cambia y el access_token
// se renueva solo en cada arranque del proceso).
auth.on('tokens', (nuevosTokens) => {
  const combinado = { ...savedTokens, ...nuevosTokens };
  if (fs.existsSync(OAUTH_CREDENTIALS_PATH)) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(combinado, null, 2));
  }
});

const drive = google.drive({ version: 'v3', auth });
const docs = google.docs({ version: 'v1', auth });

// Extrae el mensaje real de un error de la API de Google (suele venir anidado)
function mensajeErrorGoogle(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.errors?.[0]?.message ||
    error?.message ||
    'Error desconocido al comunicarse con Google.'
  );
}

/* ======================================================================
   Helpers de Drive/Docs reutilizados por crear (POST) y editar (PUT)
   ====================================================================== */

// Sube una foto nueva (base64) a una carpeta de Drive. No la hace pública;
// eso se hace aparte con hacerPublicaTemporalmente() solo cuando haga falta.
async function subirFotoNueva(base64Data, mimeType, nombreArchivo, carpetaId) {
  const buffer = Buffer.from(base64Data, 'base64');
  const archivo = await drive.files.create({
    requestBody: { name: nombreArchivo, parents: [carpetaId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id',
  });
  return archivo.data.id;
}

// Da acceso público de lectura a un archivo ya existente en Drive (necesario
// para que Google Docs pueda "descargarlo" e incrustarlo en el documento).
async function hacerPublicaTemporalmente(fileId) {
  const permiso = await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    fields: 'id',
  });
  const uri = `https://drive.google.com/uc?export=view&id=${fileId}`;
  return { permissionId: permiso.data.id, uri };
}

// Revierte el acceso público de una foto. Nunca lanza error: si falla, solo
// queda registrado en consola, para no tumbar la respuesta al usuario.
async function quitarAccesoPublico(fileId, permissionId) {
  try {
    await drive.permissions.delete({ fileId, permissionId });
  } catch (err) {
    console.error(`No se pudo revertir el acceso público del archivo ${fileId}:`, mensajeErrorGoogle(err));
  }
}

// Busca una carpeta por nombre exacto dentro de la carpeta principal. Devuelve su id o null.
async function buscarCarpetaEvidencias(nombreCarpeta) {
  const busqueda = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${nombreCarpeta.replace(/'/g, "\\'")}' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  return busqueda.data.files.length ? busqueda.data.files[0].id : null;
}

// Busca (o crea) la subcarpeta "Evidencias_<docTitle>" dentro de la carpeta principal,
// para no mezclar las fotos originales sueltas con los documentos de jornadas.
async function obtenerOCrearCarpetaEvidencias(docTitle) {
  const nombreCarpeta = `Evidencias_${docTitle}`;
  const existente = await buscarCarpetaEvidencias(nombreCarpeta);
  if (existente) return existente;
  const carpeta = await drive.files.create({
    requestBody: {
      name: nombreCarpeta,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_FOLDER_ID],
    },
    fields: 'id',
  });
  return carpeta.data.id;
}

// Si el título de la jornada cambió (por editar fecha o tipo), renombra su carpeta
// de evidencias para que coincida. Devuelve el id de la carpeta si existe, o null.
async function renombrarCarpetaEvidenciasSiExiste(oldDocTitle, newDocTitle) {
  if (oldDocTitle === newDocTitle) {
    return buscarCarpetaEvidencias(`Evidencias_${newDocTitle}`);
  }
  const folderId = await buscarCarpetaEvidencias(`Evidencias_${oldDocTitle}`);
  if (!folderId) return null;
  await drive.files.update({ fileId: folderId, requestBody: { name: `Evidencias_${newDocTitle}` } });
  return folderId;
}

// Lee y parsea un archivo JSON guardado en Drive (usado para el meta.json de cada jornada).
async function leerArchivoJSON(fileId) {
  const resp = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
  return resp.data;
}

// Carpeta oculta "_datos" donde se guardan los archivos de metadatos (.meta_*.json) de
// cada jornada, para no mezclarlos visualmente con los documentos y evidencias.
// Se busca/crea una sola vez y se guarda en memoria para no repetir la búsqueda en cada petición.
let carpetaDatosIdCache = null;
async function obtenerCarpetaDatos() {
  if (carpetaDatosIdCache) return carpetaDatosIdCache;
  const existente = await buscarCarpetaEvidencias('_datos');
  if (existente) {
    carpetaDatosIdCache = existente;
    return existente;
  }
  const carpeta = await drive.files.create({
    requestBody: { name: '_datos', mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_FOLDER_ID] },
    fields: 'id',
  });
  carpetaDatosIdCache = carpeta.data.id;
  return carpetaDatosIdCache;
}

async function crearArchivoJSON(nombre, objeto, parentId) {
  const buffer = Buffer.from(JSON.stringify(objeto), 'utf8');
  const archivo = await drive.files.create({
    requestBody: { name: nombre, parents: [parentId] },
    media: { mimeType: 'application/json', body: Readable.from(buffer) },
    fields: 'id',
  });
  return archivo.data.id;
}

async function actualizarArchivoJSON(fileId, objeto) {
  const buffer = Buffer.from(JSON.stringify(objeto), 'utf8');
  await drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body: Readable.from(buffer) },
  });
}

// Construye la lista de "requests" para escribir el contenido de una jornada en un
// Google Doc (título, metadatos, descripción, asistentes y fotos ya incrustables).
// `fotosConUri` = [{ uri, nombre }] de fotos que YA están públicas temporalmente.
function construirRequestsContenido(datos, fotosConUri) {
  const requests = [];
  let currentIndex = 1;

  const titleText = `Jornada: ${datos.tipo}\n`;
  requests.push({ insertText: { location: { index: currentIndex }, text: titleText } });
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: currentIndex, endIndex: currentIndex + titleText.length - 1 },
      fields: 'namedStyleType',
      paragraphStyle: { namedStyleType: 'TITLE' },
    },
  });
  currentIndex += titleText.length;

  const metaText = `Fecha: ${datos.fecha}\nLugar: ${datos.lugar}\nResponsable: ${datos.responsable || 'No especificado'}\n\n`;
  requests.push({ insertText: { location: { index: currentIndex }, text: metaText } });
  currentIndex += metaText.length;

  const descText = `Descripción:\n${datos.descripcion || 'Sin descripción.'}\n\n`;
  requests.push({ insertText: { location: { index: currentIndex }, text: descText } });
  currentIndex += descText.length;

  const asistentesText =
    `Asistentes (${datos.asistentes.length}):\n` +
    datos.asistentes.map(a => `\t- ${a.nombre} (C.C: ${a.cedula || 'N/A'})\n`).join('');
  requests.push({ insertText: { location: { index: currentIndex }, text: asistentesText } });
  currentIndex += asistentesText.length;

  if (fotosConUri.length > 0) {
    const encabezadoText = `\nEvidencias fotográficas (${fotosConUri.length}):\n`;
    requests.push({ insertText: { location: { index: currentIndex }, text: encabezadoText } });
    currentIndex += encabezadoText.length;

    for (const foto of fotosConUri) {
      requests.push({ insertText: { location: { index: currentIndex }, text: '\n' } });
      currentIndex += 1;

      requests.push({
        insertInlineImage: {
          location: { index: currentIndex },
          uri: foto.uri,
          objectSize: {
            height: { magnitude: 220, unit: 'PT' },
            width: { magnitude: 293, unit: 'PT' },
          },
        },
      });
      currentIndex += 1;
    }
  }

  return requests;
}

// Vacía por completo el cuerpo de un documento (usado al editar, antes de reescribirlo).
async function limpiarDocumento(documentId) {
  const doc = await docs.documents.get({ documentId, fields: 'body(content(endIndex))' });
  const content = doc.data.body.content || [];
  const endIndex = content.length ? content[content.length - 1].endIndex : 1;
  if (endIndex > 2) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }] },
    });
  }
}

// --- Middlewares ---
// Servir archivos estáticos (HTML, CSS, JS del frontend)
app.use(express.static(path.join(__dirname)));
// Parsear JSON en las peticiones. Límite más alto de lo normal porque las fotos
// viajan como texto base64 dentro del JSON (aprox. un 33% más pesadas que el archivo original).
app.use(express.json({ limit: '30mb' }));

// Si el body enviado por el navegador no es JSON válido, responder JSON (no HTML)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'El cuerpo de la petición no es JSON válido.' });
  }
  next(err);
});

// --- Rutas de la API ---

// Endpoint para obtener todas las jornadas (listado resumido)
app.get('/api/jornadas', async (req, res) => {
  console.log('Se solicitaron las jornadas');
  try {
    const response = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'files(id, name, createdTime, webViewLink, properties)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });

    const jornadas = response.data.files.map(file => {
      const [fecha, tipoSlug] = file.name.split('_');
      const props = file.properties || {};
      return {
        id: file.id,
        titulo: (tipoSlug || 'Sin tipo').replace(/-/g, ' '),
        fecha: fecha,
        lugar: props.lugar || '',
        responsable: props.responsable || '',
        creado: file.createdTime,
        enlace: file.webViewLink, // Enlace para ver el documento en el navegador
      };
    });

    res.json(jornadas);
  } catch (error) {
    const msg = mensajeErrorGoogle(error);
    console.error('Error al listar las jornadas desde Drive:', msg, error);
    res.status(500).json({ message: `Error al conectar con Google Drive: ${msg}` });
  }
});

// Endpoint para obtener el detalle completo de una jornada (usado al editar)
app.get('/api/jornadas/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`Se solicitó el detalle de la jornada ${id}`);
  try {
    const archivo = await drive.files.get({
      fileId: id,
      fields: 'id, name, properties',
      supportsAllDrives: true,
    });
    const props = archivo.data.properties || {};

    if (props.metaFileId) {
      try {
        const meta = await leerArchivoJSON(props.metaFileId);
        return res.json({
          id,
          fecha: meta.fecha,
          tipo: meta.tipo,
          lugar: meta.lugar,
          responsable: meta.responsable || '',
          descripcion: meta.descripcion || '',
          asistentes: meta.asistentes || [],
          fotos: meta.fotos || [],
        });
      } catch (err) {
        console.error('No se pudo leer el archivo de metadatos, se usará información básica del nombre:', mensajeErrorGoogle(err));
      }
    }

    // Jornada creada antes de tener esta función (o sin metadatos disponibles):
    // reconstruimos lo poco que se puede saber a partir del nombre del archivo.
    const [fecha, tipoSlug] = archivo.data.name.split('_');
    res.json({
      id,
      fecha: fecha || '',
      tipo: (tipoSlug || '').replace(/-/g, ' '),
      lugar: props.lugar || '',
      responsable: props.responsable || '',
      descripcion: '',
      asistentes: [],
      fotos: [],
      legado: true,
    });
  } catch (error) {
    const msg = mensajeErrorGoogle(error);
    console.error('Error al obtener la jornada:', msg, error);
    res.status(500).json({ message: `Error al obtener la jornada: ${msg}` });
  }
});

// Endpoint para crear una nueva jornada
app.post('/api/jornadas', async (req, res) => {
  const nuevaJornada = req.body;
  console.log('Se recibió una nueva jornada para registrar:', nuevaJornada.tipo);

  if (!nuevaJornada.fecha || !nuevaJornada.tipo || !nuevaJornada.lugar) {
    console.log('Petición rechazada: Faltan datos básicos.');
    return res.status(400).json({ message: 'Faltan datos obligatorios (fecha, tipo o lugar).' });
  }

  const docTitle = `${nuevaJornada.fecha}_${nuevaJornada.tipo.replace(/ /g, '-')}`;
  const permisosParaRevertir = []; // { fileId, permissionId }

  try {
    // 1. Crear el documento DIRECTAMENTE dentro de la carpeta compartida usando la API de Drive.
    console.log(`Creando documento: ${docTitle}`);
    const nuevoArchivo = await drive.files.create({
      requestBody: {
        name: docTitle,
        mimeType: 'application/vnd.google-apps.document',
        parents: [DRIVE_FOLDER_ID],
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    const documentId = nuevoArchivo.data.id;
    console.log(`Documento creado con ID: ${documentId}`);

    const asistentes = Array.isArray(nuevaJornada.asistentes) ? nuevaJornada.asistentes : [];
    const evidencias = Array.isArray(nuevaJornada.evidencias) ? nuevaJornada.evidencias : [];

    // 2. Subir las fotos (si hay) y prepararlas para incrustarlas en el documento.
    const fotosFinal = []; // { fileId, nombre } — esto se guarda en meta.json
    const fotosConUri = []; // { uri, nombre } — para construir el documento
    if (evidencias.length > 0) {
      console.log(`Subiendo ${evidencias.length} foto(s) de evidencia...`);
      const carpetaEvidenciasId = await obtenerOCrearCarpetaEvidencias(docTitle);
      for (let i = 0; i < evidencias.length; i++) {
        const foto = evidencias[i];
        const nombreArchivo = foto.nombre || `evidencia_${i + 1}.jpg`;
        const fileId = await subirFotoNueva(foto.data, foto.mimeType || 'image/jpeg', nombreArchivo, carpetaEvidenciasId);
        const { permissionId, uri } = await hacerPublicaTemporalmente(fileId);
        permisosParaRevertir.push({ fileId, permissionId });
        fotosFinal.push({ fileId, nombre: nombreArchivo });
        fotosConUri.push({ uri, nombre: nombreArchivo });
      }
    }

    // 3. Escribir el contenido en el documento
    console.log('Escribiendo contenido en el documento...');
    const datos = {
      tipo: nuevaJornada.tipo,
      fecha: nuevaJornada.fecha,
      lugar: nuevaJornada.lugar,
      responsable: nuevaJornada.responsable,
      descripcion: nuevaJornada.descripcion,
      asistentes,
    };
    const requests = construirRequestsContenido(datos, fotosConUri);
    await docs.documents.batchUpdate({ documentId, requestBody: { requests } });

    // 4. Guardar los metadatos completos en un archivo aparte, para poder editar la
    // jornada más adelante sin depender de volver a leer el texto del documento.
    const meta = {
      fecha: nuevaJornada.fecha,
      tipo: nuevaJornada.tipo,
      lugar: nuevaJornada.lugar,
      responsable: nuevaJornada.responsable || '',
      descripcion: nuevaJornada.descripcion || '',
      asistentes,
      fotos: fotosFinal,
    };
    const metaFileId = await crearArchivoJSON(`.meta_${documentId}.json`, meta, await obtenerCarpetaDatos());

    // 5. Guardar una referencia al archivo de metadatos y algunos datos cortos en el propio
    // documento (como propiedades), para poder mostrarlos en el listado sin leer cada meta.json.
    await drive.files.update({
      fileId: documentId,
      requestBody: {
        properties: {
          metaFileId,
          lugar: nuevaJornada.lugar.slice(0, 120),
          responsable: (nuevaJornada.responsable || '').slice(0, 120),
        },
      },
      supportsAllDrives: true,
    });

    // 6. Revertir el acceso público de las fotos: Docs ya las descargó e incrustó como copia
    // dentro del documento, así que no necesitan seguir siendo públicas.
    for (const { fileId, permissionId } of permisosParaRevertir) {
      await quitarAccesoPublico(fileId, permissionId);
    }

    console.log('¡Proceso completado con éxito!');
    res.status(201).json({ message: 'Jornada registrada y guardada en Google Drive con éxito', documentId });
  } catch (error) {
    const msg = mensajeErrorGoogle(error);
    console.error('Error al crear el documento en Google:', msg, error);
    for (const { fileId, permissionId } of permisosParaRevertir) {
      await quitarAccesoPublico(fileId, permissionId);
    }
    res.status(500).json({ message: `Error al guardar la jornada en Google Drive: ${msg}` });
  }
});

// Endpoint para editar una jornada existente
app.put('/api/jornadas/:id', async (req, res) => {
  const { id } = req.params;
  const cambios = req.body;
  console.log(`Solicitud para editar la jornada ${id}`);

  if (!cambios.fecha || !cambios.tipo || !cambios.lugar) {
    return res.status(400).json({ message: 'Faltan datos obligatorios (fecha, tipo o lugar).' });
  }

  const permisosParaRevertir = []; // { fileId, permissionId }

  try {
    const archivo = await drive.files.get({
      fileId: id,
      fields: 'id, name, properties',
      supportsAllDrives: true,
    });
    const props = archivo.data.properties || {};
    let metaFileId = props.metaFileId || null;

    let oldDocTitle = archivo.data.name;
    let fotosExistentes = []; // { fileId, nombre }
    if (metaFileId) {
      try {
        const metaVieja = await leerArchivoJSON(metaFileId);
        oldDocTitle = `${metaVieja.fecha}_${(metaVieja.tipo || '').replace(/ /g, '-')}`;
        fotosExistentes = Array.isArray(metaVieja.fotos) ? metaVieja.fotos : [];
      } catch (err) {
        console.error('No se pudo leer el meta.json anterior, se continúa sin sus fotos previas:', mensajeErrorGoogle(err));
      }
    }

    const newDocTitle = `${cambios.fecha}_${cambios.tipo.replace(/ /g, '-')}`;

    // 1. Borrar de Drive las fotos que el usuario quitó explícitamente en el formulario.
    const idsAEliminar = new Set(Array.isArray(cambios.fotosEliminar) ? cambios.fotosEliminar : []);
    for (const fotoId of idsAEliminar) {
      try {
        await drive.files.delete({ fileId: fotoId, supportsAllDrives: true });
      } catch (err) {
        console.error(`No se pudo eliminar la foto ${fotoId}:`, mensajeErrorGoogle(err));
      }
    }
    const fotosMantenidas = fotosExistentes.filter(f => !idsAEliminar.has(f.fileId));

    // 2. Subir las fotos nuevas que se hayan agregado, y de paso renombrar la carpeta de
    // evidencias si cambió el título de la jornada (fecha o tipo de actividad).
    const evidenciasNuevas = Array.isArray(cambios.evidencias) ? cambios.evidencias : [];
    const fotosNuevas = [];
    if (evidenciasNuevas.length > 0) {
      const carpetaEvidenciasId =
        (await renombrarCarpetaEvidenciasSiExiste(oldDocTitle, newDocTitle)) ||
        (await obtenerOCrearCarpetaEvidencias(newDocTitle));
      for (let i = 0; i < evidenciasNuevas.length; i++) {
        const foto = evidenciasNuevas[i];
        const nombreArchivo = foto.nombre || `evidencia_${i + 1}.jpg`;
        const fileId = await subirFotoNueva(foto.data, foto.mimeType || 'image/jpeg', nombreArchivo, carpetaEvidenciasId);
        fotosNuevas.push({ fileId, nombre: nombreArchivo });
      }
    } else if (oldDocTitle !== newDocTitle) {
      await renombrarCarpetaEvidenciasSiExiste(oldDocTitle, newDocTitle);
    }

    const fotosFinal = fotosMantenidas.concat(fotosNuevas);

    // 3. Hacer públicas temporalmente TODAS las fotos finales (las que se mantienen +
    // las nuevas) para poder reconstruir el documento con todas incrustadas.
    const fotosConUri = [];
    for (const foto of fotosFinal) {
      const { permissionId, uri } = await hacerPublicaTemporalmente(foto.fileId);
      permisosParaRevertir.push({ fileId: foto.fileId, permissionId });
      fotosConUri.push({ uri, nombre: foto.nombre });
    }

    // 4. Vaciar el documento y reescribirlo desde cero con los datos actualizados.
    await limpiarDocumento(id);
    const asistentes = Array.isArray(cambios.asistentes) ? cambios.asistentes : [];
    const datos = {
      tipo: cambios.tipo,
      fecha: cambios.fecha,
      lugar: cambios.lugar,
      responsable: cambios.responsable,
      descripcion: cambios.descripcion,
      asistentes,
    };
    const requests = construirRequestsContenido(datos, fotosConUri);
    await docs.documents.batchUpdate({ documentId: id, requestBody: { requests } });

    // 5. Renombrar el documento si cambió la fecha o el tipo de actividad.
    if (oldDocTitle !== newDocTitle) {
      await drive.files.update({ fileId: id, requestBody: { name: newDocTitle }, supportsAllDrives: true });
    }

    // 6. Guardar/actualizar el archivo de metadatos con los datos nuevos.
    const metaNueva = {
      fecha: cambios.fecha,
      tipo: cambios.tipo,
      lugar: cambios.lugar,
      responsable: cambios.responsable || '',
      descripcion: cambios.descripcion || '',
      asistentes,
      fotos: fotosFinal,
    };
    if (metaFileId) {
      await actualizarArchivoJSON(metaFileId, metaNueva);
    } else {
      metaFileId = await crearArchivoJSON(`.meta_${id}.json`, metaNueva, await obtenerCarpetaDatos());
    }
    await drive.files.update({
      fileId: id,
      requestBody: {
        properties: {
          metaFileId,
          lugar: cambios.lugar.slice(0, 120),
          responsable: (cambios.responsable || '').slice(0, 120),
        },
      },
      supportsAllDrives: true,
    });

    // 7. Revertir el acceso público de las fotos.
    for (const { fileId, permissionId } of permisosParaRevertir) {
      await quitarAccesoPublico(fileId, permissionId);
    }

    console.log('Jornada actualizada con éxito.');
    res.json({ message: 'Jornada actualizada con éxito.', documentId: id });
  } catch (error) {
    const msg = mensajeErrorGoogle(error);
    console.error('Error al editar la jornada:', msg, error);
    for (const { fileId, permissionId } of permisosParaRevertir) {
      await quitarAccesoPublico(fileId, permissionId);
    }
    res.status(500).json({ message: `Error al actualizar la jornada: ${msg}` });
  }
});

// Endpoint para eliminar una jornada
app.delete('/api/jornadas/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`Solicitud para eliminar el documento con ID: ${id}`);
  try {
    // 1. Averiguar el nombre del documento y su archivo de metadatos (si tiene).
    let docTitle = null;
    let metaFileId = null;
    try {
      const archivo = await drive.files.get({
        fileId: id,
        fields: 'name, properties',
        supportsAllDrives: true,
      });
      docTitle = archivo.data.name;
      metaFileId = archivo.data.properties ? archivo.data.properties.metaFileId : null;
    } catch (err) {
      console.error(`No se pudo obtener información del documento ${id} (puede que ya no exista):`, mensajeErrorGoogle(err));
    }

    // 2. Borrar la carpeta "Evidencias_<docTitle>" dentro de la carpeta principal, si existe.
    if (docTitle) {
      try {
        const carpetaId = await buscarCarpetaEvidencias(`Evidencias_${docTitle}`);
        if (carpetaId) {
          console.log(`Eliminando carpeta de evidencias de "${docTitle}"`);
          await drive.files.delete({ fileId: carpetaId, supportsAllDrives: true });
        }
      } catch (err) {
        // No dejamos que un fallo aquí impida borrar el documento principal.
        console.error(`No se pudo eliminar la carpeta de evidencias de "${docTitle}":`, mensajeErrorGoogle(err));
      }
    }

    // 3. Borrar el archivo de metadatos asociado, si existe.
    if (metaFileId) {
      try {
        await drive.files.delete({ fileId: metaFileId, supportsAllDrives: true });
      } catch (err) {
        console.error(`No se pudo eliminar el archivo de metadatos ${metaFileId}:`, mensajeErrorGoogle(err));
      }
    }

    // 4. Eliminar el documento de la jornada en sí.
    await drive.files.delete({ fileId: id, supportsAllDrives: true });
    console.log('Documento eliminado con éxito.');
    res.status(200).json({ message: 'Jornada eliminada de Google Drive con éxito.' });
  } catch (error) {
    const msg = mensajeErrorGoogle(error);
    console.error('Error al eliminar el documento:', msg, error);
    res.status(500).json({ message: `Error al eliminar la jornada: ${msg}` });
  }
});

// Red de seguridad: cualquier error no capturado en una ruta cae aquí,
// y SIEMPRE responde JSON en vez de dejar la conexión vacía/cortada.
app.use((err, req, res, next) => {
  console.error('Error no controlado:', err);
  if (!res.headersSent) {
    res.status(500).json({ message: `Error interno del servidor: ${err.message}` });
  }
});

// Evitar que el proceso entero se caiga (y corte todas las conexiones)
// por una promesa rechazada sin capturar en alguna llamada a Google.
process.on('unhandledRejection', (reason) => {
  console.error('Promesa rechazada sin capturar:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Excepción no capturada:', err);
});

const server = app.listen(port, () => {
  console.log(`Servidor backend escuchando en http://localhost:${port}`);
  console.log('Abre tu navegador en esa dirección para ver la aplicación.');
});

// Aumentamos el tiempo de espera a 5 minutos (300000 ms) para evitar timeouts
// en operaciones largas con la API de Google.
server.setTimeout(300000);