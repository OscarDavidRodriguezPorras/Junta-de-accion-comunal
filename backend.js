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
const DRIVE_FOLDER_ID = '1G1yWE93Y3B37XQdQsRpT_d4RYMkAcTso';

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

// Sube una foto (base64) a una subcarpeta "Evidencias" dentro de DRIVE_FOLDER_ID,
// la hace públicamente visible por un momento (necesario para que Docs pueda "descargarla"
// e incrustarla), y devuelve el fileId + el permissionId público, para poder revertirlo después.
async function subirFotoTemporalmentePublica(base64Data, mimeType, nombreArchivo, carpetaId) {
  const buffer = Buffer.from(base64Data, 'base64');
  const archivo = await drive.files.create({
    requestBody: { name: nombreArchivo, parents: [carpetaId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id',
  });
  const fileId = archivo.data.id;

  const permiso = await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    fields: 'id',
  });

  const uri = `https://drive.google.com/uc?export=view&id=${fileId}`;
  return { fileId, permissionId: permiso.data.id, uri };
}

// Busca (o crea) la subcarpeta "Evidencias/<docTitle>" dentro de la carpeta principal,
// para no mezclar las fotos originales sueltas con los documentos de jornadas.
async function obtenerCarpetaEvidencias(docTitle) {
  const nombreCarpeta = `Evidencias_${docTitle}`;
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

// --- Rutas de la API (simuladas) ---

// Endpoint para obtener todas las jornadas
app.get('/api/jornadas', async (req, res) => {
  console.log('Se solicitaron las jornadas');
  try {
    const response = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'files(id, name, createdTime, webViewLink)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });

    const jornadas = response.data.files.map(file => {
      const [fecha, tipo] = file.name.split('_');
      return {
        id: file.id,
        titulo: (tipo || 'Sin tipo').replace(/-/g, ' '),
        fecha: fecha,
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

// Endpoint para crear una nueva jornada
app.post('/api/jornadas', async (req, res) => {
  const nuevaJornada = req.body;
  console.log('Se recibió una nueva jornada para registrar:', nuevaJornada.tipo);

  // --- Validación de Datos (Mejora) ---
  if (!nuevaJornada.fecha || !nuevaJornada.tipo || !nuevaJornada.lugar) {
    console.log('Petición rechazada: Faltan datos básicos.');
    return res.status(400).json({ message: 'Faltan datos obligatorios (fecha, tipo o lugar).' });
  }

  // 1. Crear un título para el documento
  const docTitle = `${nuevaJornada.fecha}_${nuevaJornada.tipo.replace(/ /g, '-')}`;

  try {
    // 2. Crear el documento DIRECTAMENTE dentro de la carpeta compartida usando la API de Drive.
    // (Antes se creaba con docs.documents.create(), pero eso crea el archivo en el espacio propio
    // de la cuenta de servicio -que no tiene cuota propia- y fallaba con "permission denied"
    // antes de llegar a moverlo a la carpeta. Creándolo ya con `parents` evita ese problema.)
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

    // 3. Preparar las peticiones para escribir en el documento (en orden)
    const requests = [];
    let currentIndex = 1;

    // Título
    const titleText = `Jornada: ${nuevaJornada.tipo}\n`;
    requests.push({ insertText: { location: { index: currentIndex }, text: titleText } });
    requests.push({ updateParagraphStyle: { range: { startIndex: currentIndex, endIndex: currentIndex + titleText.length -1 }, fields: 'namedStyleType', paragraphStyle: { namedStyleType: 'TITLE' } } });
    currentIndex += titleText.length;

    // Metadatos
    const metaText = `Fecha: ${nuevaJornada.fecha}\nLugar: ${nuevaJornada.lugar}\nResponsable: ${nuevaJornada.responsable || 'No especificado'}\n\n`;
    requests.push({ insertText: { location: { index: currentIndex }, text: metaText } });
    currentIndex += metaText.length;

    // Descripción
    const descText = `Descripción:\n${nuevaJornada.descripcion || 'Sin descripción.'}\n\n`;
    requests.push({ insertText: { location: { index: currentIndex }, text: descText } });
    currentIndex += descText.length;

    // Asistentes
    const asistentesText = `Asistentes (${nuevaJornada.asistentes.length}):\n` + nuevaJornada.asistentes.map(a => `\t- ${a.nombre} (C.C: ${a.cedula || 'N/A'})\n`).join('');
    requests.push({ insertText: { location: { index: currentIndex }, text: asistentesText } });
    currentIndex += asistentesText.length;

    // Evidencias fotográficas (opcional): nuevaJornada.evidencias = [{ data, mimeType, nombre }, ...]
    // "data" viene en base64 (sin el prefijo "data:image/...;base64,").
    const fotosSubidas = []; // { fileId, permissionId } — para revertir el acceso público al final
    const evidencias = Array.isArray(nuevaJornada.evidencias) ? nuevaJornada.evidencias : [];

    if (evidencias.length > 0) {
      console.log(`Subiendo ${evidencias.length} foto(s) de evidencia...`);
      const carpetaEvidenciasId = await obtenerCarpetaEvidencias(docTitle);

      const encabezadoText = `\nEvidencias fotográficas (${evidencias.length}):\n`;
      requests.push({ insertText: { location: { index: currentIndex }, text: encabezadoText } });
      currentIndex += encabezadoText.length;

      for (let i = 0; i < evidencias.length; i++) {
        const foto = evidencias[i];
        const nombreArchivo = foto.nombre || `evidencia_${i + 1}.jpg`;
        const { fileId, permissionId, uri } = await subirFotoTemporalmentePublica(
          foto.data,
          foto.mimeType || 'image/jpeg',
          nombreArchivo,
          carpetaEvidenciasId
        );
        fotosSubidas.push({ fileId, permissionId });

        // Salto de línea antes de cada imagen
        requests.push({ insertText: { location: { index: currentIndex }, text: '\n' } });
        currentIndex += 1;

        requests.push({
          insertInlineImage: {
            location: { index: currentIndex },
            uri,
            objectSize: {
              height: { magnitude: 220, unit: 'PT' },
              width: { magnitude: 293, unit: 'PT' },
            },
          },
        });
        currentIndex += 1; // una imagen incrustada cuenta como una posición de índice
      }
    }

    // 4. Escribir el contenido en el documento
    console.log('Escribiendo contenido en el documento...');
    await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: {
        requests: requests,
      },
    });

    // 5. Ya no hace falta mover el documento: se creó directamente dentro de la carpeta correcta.

    // 6. Revertir el acceso público de las fotos: Docs ya las descargó e incrustó como copia
    // dentro del documento, así que no necesitan seguir siendo públicas. Si algo falla aquí,
    // solo lo dejamos registrado en consola — no debe tumbar la respuesta al usuario, porque
    // el documento ya se creó correctamente.
    for (const { fileId, permissionId } of fotosSubidas) {
      try {
        await drive.permissions.delete({ fileId, permissionId });
      } catch (err) {
        console.error(`No se pudo revertir el acceso público de la foto ${fileId}:`, mensajeErrorGoogle(err));
      }
    }

    console.log('¡Proceso completado con éxito!');
    res.status(201).json({ message: 'Jornada registrada y guardada en Google Drive con éxito', documentId: documentId });

  } catch (error) {
    const msg = mensajeErrorGoogle(error);
    console.error('Error al crear el documento en Google:', msg, error);
    res.status(500).json({ message: `Error al guardar la jornada en Google Drive: ${msg}` });
  }
});

// Endpoint para eliminar una jornada
app.delete('/api/jornadas/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`Solicitud para eliminar el documento con ID: ${id}`);
  try {
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