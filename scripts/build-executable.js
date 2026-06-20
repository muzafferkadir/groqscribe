#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outfile = resolve(root, 'dist/groqscribe');
const helperPath = resolve(root, 'bin/system-audio-capture');
const helperBase64 = existsSync(helperPath) ? readFileSync(helperPath).toString('base64') : '';

mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, 'cli/main.js')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'bundle',
  define: {
    __SYSTEM_AUDIO_HELPER_BASE64__: JSON.stringify(helperBase64),
    __SYSTEM_AUDIO_HELPER_PLATFORM__: JSON.stringify(helperBase64 ? process.platform : ''),
    __SYSTEM_AUDIO_HELPER_ARCH__: JSON.stringify(helperBase64 ? process.arch : ''),
  },
  logLevel: 'info',
});

chmodSync(outfile, 0o755);
console.log(`Executable ready: ${outfile}`);
console.log(helperBase64 ? `System audio helper embedded: ${process.platform}/${process.arch}` : 'System audio helper not found; executable was built without embedding it.');
console.log('Run: ./dist/groqscribe');
