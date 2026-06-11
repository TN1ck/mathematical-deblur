import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // relative base so the build works at any path (e.g. GitHub Pages subpath)
  base: './',
  plugins: [react()],
  // The wasm-bindgen glue resolves its .wasm file with
  // `new URL(..., import.meta.url)`; pre-bundling would break that.
  optimizeDeps: {
    exclude: ['smartdeblur-core'],
  },
  server: {
    fs: {
      // serve the wasm package from ../rust-core/pkg in dev
      allow: ['..'],
    },
  },
  worker: {
    format: 'es',
  },
})
