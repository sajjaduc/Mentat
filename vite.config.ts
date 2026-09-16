import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5273,
    strictPort: false
  },
  optimizeDeps: {
    // The GCS SDK is loaded lazily by the GCS blob store only.
    exclude: ['@google-cloud/storage']
  }
});
