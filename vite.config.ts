import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the same build loads from app://player (desktop) or any web host.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
})
