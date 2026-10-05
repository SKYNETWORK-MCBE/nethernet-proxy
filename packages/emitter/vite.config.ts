import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
