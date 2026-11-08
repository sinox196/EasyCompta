import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, query } from './db.js';
import { startWorker } from './worker.js';
import { aiConfigured, aiDescription } from './ai/extract.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { entriesRouter } from './routes/entries.js';
import { analyseRouter } from './routes/analyse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, ai: aiConfigured(), provider: aiDescription() });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database' });
  }
});

app.use('/api', authRouter);
app.use('/api', entriesRouter);
app.use('/api', documentsRouter);
app.use('/api', analyseRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.use(
  express.static(publicDir, {
    extensions: ['html'],
    setHeaders: (res, file) => {
      if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
app.get('/scan', (req, res) => res.sendFile(path.join(publicDir, 'scan.html')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Erreur serveur' });
});

const port = Number(process.env.PORT || 3000);

async function main() {
  await migrate();
  app.listen(port, () => console.log(`EasyCompta en ligne sur le port ${port}`));
  if (process.env.WORKER_DISABLED !== '1') startWorker();
}

main().catch((err) => {
  console.error('Démarrage impossible :', err);
  process.exit(1);
});
