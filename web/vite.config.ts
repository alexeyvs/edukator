import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // `changeOrigin` выписан руками и именно `false`: строкой-сокращением
      // (`'/api': 'http://localhost:3000'`) Vite включает его сам, подменяя
      // `Host` на адрес цели. Изменяющий запрос сверяет `Origin` с `Host`
      // (`isSameOrigin`), и подменённый `Host` разводил бы их всегда — в dev
      // каждый вход, выход и ответ ученика получал бы 403 «запрос пришёл не со
      // страницы приложения». `npm start` и e2e одноисточниковые и этого не
      // ловят.
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
