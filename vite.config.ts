import yaml from '@rollup/plugin-yaml'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss(), yaml()],
  resolve: { alias: {
    '@': '/src',
    'server': '/server',
  } },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        ws: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})
