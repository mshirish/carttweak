import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // browser never sees secrets; it talks to our server
    proxy: { '/api': 'http://localhost:8787' },
  },
});
