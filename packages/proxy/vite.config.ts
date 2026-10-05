import { defineConfig } from 'vite-plus'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node26',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    alias: {
      '@nethernet-proxy/emitter': fileURLToPath(
        new URL('../emitter/src/index.ts', import.meta.url),
      ),
      '@nethernet-proxy/relay': fileURLToPath(new URL('../relay/src/index.ts', import.meta.url)),
    },
  },
})
