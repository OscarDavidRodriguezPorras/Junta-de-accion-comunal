// Script de autorización ÚNICA. Corre "node authorize.js" una sola vez
// para autorizar tu cuenta personal de Google (gmaster2009os@gmail.com).
// Esto genera un archivo token.json que backend.js usará después.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

const OAUTH_CREDENTIALS_PATH = path.join(__dirname, 'oauth-credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];
const PORT = 4321;
const REDIRECT_URI = `http://localhost:${PORT}`;

function main() {
  if (!fs.existsSync(OAUTH_CREDENTIALS_PATH)) {
    console.error(`No encuentro ${OAUTH_CREDENTIALS_PATH}`);
    console.error('Descarga el JSON de OAuth desde Google Cloud Console y guárdalo como oauth-credentials.json en esta carpeta.');
    process.exit(1);
  }

  const keys = JSON.parse(fs.readFileSync(OAUTH_CREDENTIALS_PATH, 'utf8'));
  const creds = keys.installed || keys.web;
  const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // necesario para obtener refresh_token
    prompt: 'consent',      // fuerza a que siempre entregue refresh_token
    scope: SCOPES,
  });

  console.log('\n=== Autorización de Google Drive/Docs ===\n');
  console.log('1. Abre esta URL en tu navegador, con la cuenta gmaster2009os@gmail.com:\n');
  console.log(authUrl);
  console.log('\n2. Google puede advertir que "la app no está verificada": haz clic en');
  console.log('   "Configuración avanzada" -> "Ir a JAC Backend (no seguro)". Es normal,');
  console.log('   es tu propia app en modo de prueba, solo tú puedes usarla.');
  console.log('\n3. Acepta los permisos. El navegador puede mostrar una página de error');
  console.log('   al final ("no se puede acceder a este sitio") — es normal, no cierres');
  console.log('   la terminal, el código ya habrá sido capturado aquí.\n');
  console.log('Esperando autorización...\n');

  const server = http
    .createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, REDIRECT_URI);
        const code = reqUrl.searchParams.get('code');

        if (!code) {
          res.end('No se recibió ningún código. Puedes cerrar esta pestaña e intentar de nuevo.');
          return;
        }

        res.end('¡Autorización completada! Ya puedes cerrar esta pestaña y volver a la terminal.');

        const { tokens } = await oAuth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('✅ Token guardado en', TOKEN_PATH);
        console.log('Listo. Ahora corre: node backend.js\n');
        server.close();
        process.exit(0);
      } catch (err) {
        console.error('Error al obtener el token:', err.message || err);
        res.end('Ocurrió un error. Revisa la terminal.');
        process.exit(1);
      }
    })
    .listen(PORT);
}

main();