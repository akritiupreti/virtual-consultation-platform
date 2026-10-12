import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server on :5173 (the backend's default CORS origin). The API base URL is
// configured via VITE_API_URL (see .env.example); it defaults to :3000.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
