import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the same build loads from app://player (desktop) or any web host.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    // The limiter worklet ships as its own file: the desktop app's content security policy
    // (script-src 'self') doesn't run scripts from data: URLs, which small assets would become.
    assetsInlineLimit: (file) => (file.endsWith('.worklet.js') ? false : undefined),
  },
})
