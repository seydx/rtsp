import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dts from 'unplugin-dts/vite';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
      entryRoot: resolve(__dirname, 'src'),
      exclude: ['**/__tests__/**', '**/*.spec.ts'],
    }),
  ],
  build: {
    target: 'node22',
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'sources/index': resolve(__dirname, 'src/sources/index.ts'),
        'sinks/index': resolve(__dirname, 'src/sinks/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // Keep node built-ins and the native node-av binding external.
      external: [/^node:/, 'node-av', /^node-av\//, 'get-port'],
      output: {
        preserveModules: false,
      },
    },
  },
});
