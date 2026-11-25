import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vitest/config';

const CUSTOM_PACK_PREFIX = '/__custom_pack__/';
const CUSTOM_PACK_DIR = path.resolve(process.cwd(), '.krunked-cells-assets');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.fnt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function handleCustomPackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const rawUrl = req.url ?? '';
  if (!rawUrl.startsWith(CUSTOM_PACK_PREFIX)) {
    next();
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end('Method Not Allowed');
    return;
  }

  const urlPath = rawUrl.split('?')[0];
  const relSegment = urlPath.slice(CUSTOM_PACK_PREFIX.length);

  if (relSegment === 'status') {
    const manifestPath = path.join(CUSTOM_PACK_DIR, 'manifest.json');
    const available = fs.existsSync(manifestPath);
    let atlasCount = 0;
    let audioCount = 0;

    if (available) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          atlases?: Record<string, unknown>;
          audioSfx?: Record<string, unknown>;
          audioMusic?: Record<string, unknown>;
        };
        atlasCount = parsed.atlases ? Object.keys(parsed.atlases).length : 0;
        audioCount =
          (parsed.audioSfx ? Object.keys(parsed.audioSfx).length : 0) +
          (parsed.audioMusic ? Object.keys(parsed.audioMusic).length : 0);
      } catch {
        // Leave counts at 0 if manifest cannot be parsed.
      }
    }

    const body = JSON.stringify({
      available,
      manifestUrl: `${CUSTOM_PACK_PREFIX}manifest.json`,
      atlasCount,
      audioCount,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
    return;
  }

  let decodedRel: string;
  try {
    decodedRel = decodeURIComponent(relSegment);
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  if (!decodedRel || decodedRel.includes('\0') || decodedRel.includes('\\')) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const normalizedRel = path.posix.normalize(`/${decodedRel}`).replace(/^\/+/, '');
  const resolvedPath = path.resolve(CUSTOM_PACK_DIR, normalizedRel);
  const rootWithSep = CUSTOM_PACK_DIR.endsWith(path.sep)
    ? CUSTOM_PACK_DIR
    : `${CUSTOM_PACK_DIR}${path.sep}`;

  if (!resolvedPath.startsWith(rootWithSep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', getContentType(resolvedPath));
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-cache');

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(resolvedPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end();
  });
  stream.pipe(res);
}

function krunkedCustomPackPlugin(): Plugin {
  return {
    name: 'krunked-custom-pack-middleware',
    configureServer(server) {
      server.middlewares.use(handleCustomPackRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleCustomPackRequest);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [krunkedCustomPackPlugin()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
