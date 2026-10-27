import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    // Security helpers read these values when their modules are imported.
    // Use deterministic test-only values so the suite never depends on a
    // developer's private .env credentials.
    env: {
      ENCRYPTION_KEY: '11'.repeat(32),
      META_APP_SECRET: 'vitest-meta-app-secret',
    },
  },
})
