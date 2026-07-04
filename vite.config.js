import { defineConfig } from 'vite';

export default defineConfig({
   root: '.',
   publicDir: 'public',
   server: {
      port: 5175,
      strictPort: false,
      open: true,
   },
   build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'es2022',
   },
});
