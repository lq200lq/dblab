import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 前端只认同源 /api：cookie 会话走同源请求，不用为跨源再开 CORS。
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
      '/health': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
})
