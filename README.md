# Carpeta Comunal — Registro de Jornadas

Aplicación web para que una Junta de Acción Comunal (JAC) registre sus jornadas comunitarias (mantenimiento vial, aseo, reforestación, reuniones, etc.) directamente como documentos de **Google Docs**, organizados dentro de una carpeta de **Google Drive**, con asistentes, descripción y evidencias fotográficas.

No usa base de datos propia: Google Drive **es** la base de datos.

---

## Tabla de contenido

- [Características](#características)
- [Cómo funciona](#cómo-funciona)
- [Estructura en Google Drive](#estructura-en-google-drive)
- [Stack técnico](#stack-técnico)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Requisitos previos](#requisitos-previos)
- [Configuración de Google Cloud](#configuración-de-google-cloud)
- [Instalación y ejecución local](#instalación-y-ejecución-local)
- [Despliegue en Render](#despliegue-en-render)
- [Variables de entorno](#variables-de-entorno)
- [Referencia de la API](#referencia-de-la-api)
- [Limitaciones conocidas](#limitaciones-conocidas)

---

## Características

- **Registrar jornadas**: fecha, tipo de actividad, lugar, responsable, descripción, lista de asistentes (nombre + cédula) y hasta 6 fotos de evidencia.
- **Editar jornadas** ya creadas, incluyendo agregar o quitar fotos individualmente.
- **Eliminar jornadas**, lo que también elimina su carpeta de evidencias y sus metadatos asociados en Drive.
- **Historial con filtros**: búsqueda por texto (tipo, lugar, responsable), filtro por tipo de actividad y por rango de fechas.
- Cada jornada se guarda como un **Google Doc** con formato (título, metadatos, descripción, listado de asistentes e imágenes incrustadas), accesible directamente desde Google Drive.
- Interfaz responsive (escritorio y móvil).

## Cómo funciona

1. El **frontend** (`index.html` + `script.js` + `style.css`) es HTML/CSS/JS puro, sin frameworks ni build step.
2. El **backend** (`backend.js`, Node + Express) se autentica contra la API de Google con OAuth 2.0 (como una cuenta personal, no como cuenta de servicio) y expone una API REST (`/api/jornadas`).
3. Al registrar una jornada, el backend:
   - Crea un Google Doc dentro de la carpeta configurada.
   - Sube las fotos a una subcarpeta de evidencias, las hace públicas por unos segundos (necesario para que la API de Docs pueda incrustarlas), las inserta en el documento, y revierte el acceso público.
   - Guarda un archivo `.json` con los datos estructurados de la jornada (para poder editarla más adelante con precisión, sin tener que "leer" el documento de Google).
4. Todo el contenido vive en la cuenta de Google Drive del usuario que autorizó la aplicación — no hay servidor de archivos ni base de datos propia que mantener.

## Estructura en Google Drive

Dentro de la carpeta principal (`DRIVE_FOLDER_ID`) se genera esta estructura:

```
Carpeta principal/
├── 2025-03-10_Mantenimiento-vial          (Google Doc de la jornada)
├── 2025-03-10_Mantenimiento-vial.gdoc
├── Evidencias_2025-03-10_Mantenimiento-vial/   (subcarpeta, solo si hubo fotos)
│   ├── evidencia_1.jpg
│   └── evidencia_2.jpg
├── _datos/                                 (oculta a simple vista, uso interno)
│   └── .meta_<id-del-documento>.json       (datos estructurados de cada jornada)
└── ...
```

Los archivos dentro de `_datos/` no están pensados para abrirse manualmente: son el respaldo que usa la app para poder editar cada jornada con exactitud.

## Stack técnico

| Parte      | Tecnología                                   |
|------------|-----------------------------------------------|
| Frontend   | HTML, CSS, JavaScript (vanilla, sin frameworks) |
| Backend    | Node.js, Express                              |
| Integración | [`googleapis`](https://www.npmjs.com/package/googleapis) (Drive API v3, Docs API v1) |
| Autenticación | OAuth 2.0 (cliente de escritorio)          |
| Hosting    | Render (o cualquier servicio que corra Node.js) |

## Estructura del proyecto

```
.
├── backend.js              # Servidor Express + lógica de integración con Google
├── authorize.js             # Script de un solo uso para autorizar la cuenta de Google
├── index.html                # Interfaz (estructura)
├── script.js                  # Interfaz (lógica: formularios, filtros, llamadas a la API)
├── style.css                   # Interfaz (estilos)
├── package.json
├── .gitignore                # Excluye credenciales y tokens del repositorio
├── oauth-credentials.json    # (NO se sube a git) Credenciales OAuth descargadas de Google Cloud
└── token.json                 # (NO se sube a git) Generado por authorize.js
```

## Requisitos previos

- Node.js 18 o superior.
- Una cuenta de Google (Gmail normal, no requiere Google Workspace).
- Un proyecto en [Google Cloud Console](https://console.cloud.google.com/) con la Drive API y la Docs API activadas.

## Configuración de Google Cloud

1. **Crear el proyecto**: en Google Cloud Console, crea un proyecto nuevo con la cuenta de Google que usará la aplicación.
2. **Activar APIs**: en *APIs y servicios → Biblioteca*, activa **Google Drive API** y **Google Docs API**.
3. **Pantalla de consentimiento OAuth**: tipo *Externo*, con un nombre para la app. Puede quedar en modo *Prueba* (no es necesario enviarla a verificación de Google).
4. **Usuarios de prueba**: agrega el correo de la cuenta que usarás.
5. **Credenciales**: en *APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth*, tipo **Aplicación de escritorio**. Descarga el JSON resultante y guárdalo como `oauth-credentials.json` en la raíz del proyecto.
6. **Carpeta de Drive**: crea (o elige) la carpeta donde se guardarán las jornadas, y copia su ID desde la URL (`https://drive.google.com/drive/folders/<ID>`). Pega ese ID en la constante `DRIVE_FOLDER_ID` de `backend.js`.

## Instalación y ejecución local

```bash
# 1. Instalar dependencias
npm install

# 2. Autorizar tu cuenta de Google (una sola vez)
node authorize.js
# Abre la URL que imprime en la terminal, inicia sesión con la cuenta correcta,
# acepta los permisos. Esto genera token.json.

# 3. Iniciar el servidor
npm start
# o: node backend.js
```

Luego abre `http://localhost:3000` en el navegador.

## Despliegue en Render

`oauth-credentials.json` y `token.json` están en `.gitignore` a propósito (contienen secretos) y por lo tanto no viajan al repositorio. Para producción, el backend los busca primero como archivos locales y, si no existen, los lee desde variables de entorno:

1. En el panel de Render → *Environment*, crea:
   - `GOOGLE_OAUTH_CREDENTIALS`: contenido completo de `oauth-credentials.json`.
   - `GOOGLE_TOKEN`: contenido completo de `token.json`.
2. Verifica que `DRIVE_FOLDER_ID` en `backend.js` apunte a la carpeta correcta antes de desplegar.
3. Comando de inicio: `node backend.js` (o `npm start`).

## Variables de entorno

| Variable                  | Requerida | Descripción                                                        |
|----------------------------|:---------:|----------------------------------------------------------------------|
| `GOOGLE_OAUTH_CREDENTIALS` | Solo si no existe `oauth-credentials.json` local | JSON completo de las credenciales OAuth de escritorio |
| `GOOGLE_TOKEN`             | Solo si no existe `token.json` local | JSON completo del token generado por `authorize.js` |
| `PORT`                     | No        | Puerto del servidor (Render lo define automáticamente)             |

## Referencia de la API

Todas las rutas responden JSON.

| Método | Ruta                | Descripción                                                |
|--------|----------------------|--------------------------------------------------------------|
| GET    | `/api/jornadas`       | Lista todas las jornadas (resumen: id, título, fecha, lugar, responsable, enlace). |
| GET    | `/api/jornadas/:id`   | Detalle completo de una jornada (para el formulario de edición). |
| POST   | `/api/jornadas`       | Crea una nueva jornada.                                     |
| PUT    | `/api/jornadas/:id`   | Edita una jornada existente.                                |
| DELETE | `/api/jornadas/:id`   | Elimina una jornada, su carpeta de evidencias y sus metadatos. |

**Cuerpo esperado en `POST` / `PUT`:**

```json
{
  "fecha": "2025-03-10",
  "tipo": "Mantenimiento vial",
  "lugar": "Cancha múltiple, sector La Loma",
  "responsable": "Presidente de la JAC",
  "descripcion": "Se repararon los huecos de la vía principal...",
  "asistentes": [
    { "nombre": "Juan Pérez", "cedula": "1020304050" }
  ],
  "evidencias": [
    { "data": "<base64 sin el prefijo data:image/...>", "mimeType": "image/jpeg", "nombre": "foto1.jpg" }
  ],
  "fotosEliminar": ["<fileId de Drive a eliminar>"]
}
```

`evidencias` y `fotosEliminar` son opcionales; `fotosEliminar` solo aplica a `PUT`.

## Limitaciones conocidas

- La cuenta de Google usada consume **su propia cuota de almacenamiento de Drive** (no hay cuota separada como con una cuenta de servicio de Workspace).
- No hay autenticación de usuarios en la aplicación: cualquiera con la URL puede crear, editar y eliminar jornadas. Si se va a usar en producción de forma más amplia, se recomienda agregar una capa de autenticación.
- Las jornadas creadas antes de la función de edición no tienen archivo de metadatos (`.meta_*.json`); al editarlas por primera vez, la descripción y los asistentes aparecerán vacíos hasta que se completen y se guarden una vez.
- El token de acceso se renueva automáticamente mientras el `refresh_token` siga siendo válido; si se revoca manualmente desde la cuenta de Google, es necesario volver a correr `authorize.js`.
