// build.mjs — сборка ES-модулей в один dist/index.html. Ноль зависимостей.
// Стратегия: вырезаем import/export, склеиваем модули в порядке зависимостей.
// Работает, потому что все имена в проекте уникальны.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ORDER = [
  'src/engine/rng.js',
  'src/engine/map.js',
  'src/engine/player.js',
  'src/engine/combat.js',
  'src/engine/game.js',
  'src/ai/client.js',
  'src/ai/dm.js',
  'src/ai/stub.js',
  'src/net/protocol.js',
  'src/net/loopback.js',
  'src/net/ice.js',
  'src/net/mqtt-signal.js',
  'src/net/webrtc.js',
  'src/net/host.js',
  'src/net/client.js',
  'src/net/peer.js',
  'src/ui/sound.js',
  'src/ui/avatar.js',
  'src/ui/theme.js',
  'src/ui/terminal.js',
  'src/ui/app.js'
];

let code = ORDER
  .map(f => readFileSync(join(process.cwd(), f), 'utf8'))
  .join('\n\n');

// 1) вырезать import- statements (в т.ч. многострочные)
code = code.replace(/import\s+[^;']*?from\s*['"][^'"]*['"];?/g, '');
code = code.replace(/^import\s+['"][^'"]*['"];?\s*$/gm, '');

// 2) export function/const/let/var/class/async function → убрать слово export
code = code.replace(/^export\s+(?=(async\s+)?(function|const|let|var|class))/gm, '');

// 3) export { a, b }; — bare re-export → вырезать целиком
code = code.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

// 4) проверка на остатки модульного синтаксиса
const leftovers = code.match(/^\s*(import|export)\b.*$/gm);
if (leftovers) {
  console.error('ОСТАЛИСЬ модульные конструкции:');
  console.error(leftovers.join('\n'));
  process.exit(1);
}

const template = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
if (!template.includes('/*__BUNDLE__*/')) {
  console.error('В index.html нет плейсхолдера /*__BUNDLE__*/');
  process.exit(1);
}

const out = template.replace('/*__BUNDLE__*/', () => code);
mkdirSync(join(process.cwd(), 'dist'), { recursive: true });
writeFileSync(join(process.cwd(), 'dist/index.html'), out);
// копия в docs/ для GitHub Pages (страница собирается с main:/docs)
mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
writeFileSync(join(process.cwd(), 'docs/index.html'), out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`OK: dist/index.html + docs/index.html (${kb} KB)`);
