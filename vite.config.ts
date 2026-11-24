import { defineConfig, type Plugin } from 'vite';

function standardTimePlugin(): Plugin {
  const handle = (_request: unknown, response: { setHeader: (k: string, v: string) => void; end: (body: string) => void }) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ now: Date.now() }));
  };
  return {
    name: 'county-radio-standard-time',
    configureServer(server) {
      server.middlewares.use('/api/time', handle as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/time', handle as never);
    },
  };
}

export default defineConfig({
  plugins: [standardTimePlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
