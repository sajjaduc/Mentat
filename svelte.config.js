import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    alias: {
      $server: 'src/lib/server',
      $ui: 'src/lib/ui',
      $shared: 'src/lib/shared'
    },
    csrf: {
      // Local deployment serves the app from one origin; SvelteKit's default
      // origin check is retained through this explicit trusted origin list.
      trustedOrigins: ['http://localhost:5273', 'http://127.0.0.1:5273']
    },
    files: {
      assets: 'static'
    }
  }
};

export default config;
