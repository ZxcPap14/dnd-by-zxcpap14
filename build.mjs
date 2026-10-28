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
  'src/engine/parser.js',
  'src/engine/game.js',
  'src/ai/client.js',
  'src/ai/dm.js',
  'src/ai/stub.js',
  'src/net/protocol.js',
  'src/net/loopback.js',
  'src/net/host.js',
  'src/net/client.js',
  'src/net/peer.js',
  'src/net/trystero.js',
  'src/net/hybrid.js',
  'src/ui/sound.js',
  'src/ui/avatar.js',
  'src/ui/theme.js',
  'src/ui/terminal.js',
  'src/ui/app.js'
];

let code = ORDER
  .map(f => readFileSync(join(process.cwd(), f), 'utf8'))
  .join('\n\n');

// 0) защита от коллизий имён. Модули склеиваются в ОДНУ область видимости:
//    повторный const/let/class = SyntaxError, и весь бандл молча не запускается
//    (ровно так сломался кооп, когда в peer.js и trystero.js оказались два sleep).
const seen = new Map();
const dupes = [];
for (const f of ORDER) {
  const src = readFileSync(join(process.cwd(), f), 'utf8');
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seen.has(name)) dupes.push(`${name} — ${seen.get(name)} ↔ ${f}`);
    else seen.set(name, f);
  }
}
if (dupes.length) {
  console.error('КОЛЛИЗИИ ИМЁН (бандл не запустится):');
  dupes.forEach(d => console.error('  ' + d));
  process.exit(1);
}

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
