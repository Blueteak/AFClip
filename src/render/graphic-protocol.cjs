const fs = require('node:fs');
const path = require('node:path');
const bridge = fs.readFileSync(path.join(__dirname, 'graphic-text-bridge.js'), 'utf8');
module.exports = function registerGraphics(protocol, config) {
  protocol.handle('afclip-graphic', request => {
    try {
      const url = new URL(request.url), graphic = config.graphics[url.hostname]; if (!graphic) return new Response('Unknown graphic', { status: 404 });
      const root = fs.realpathSync(graphic.root), file = fs.realpathSync(path.join(root, decodeURIComponent(url.pathname)));
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return new Response('Forbidden', { status: 403 });
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
      let body = fs.readFileSync(file);
      if (path.extname(file).toLowerCase() === '.html') {
        const html = body.toString('utf8'), script = `<script>${bridge}</script>`;
        body = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + script) : html + script;
      }
      return new Response(body, { headers: { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "default-src 'none'; script-src afclip-graphic: 'unsafe-inline'; style-src afclip-graphic: 'unsafe-inline'; img-src afclip-graphic: data:; font-src afclip-graphic:; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';" } });
    } catch { return new Response('Asset unavailable', { status: 404 }); }
  });
};
