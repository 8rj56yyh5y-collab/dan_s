'use strict';
/*
 * Открыть БХ Учёт для коллег: запускает сервер и создаёт временную публичную ссылку через Cloudflare Tunnel.
 *
 *   npm run share
 *
 * Ссылка вида https://xxxx.trycloudflare.com работает, пока открыто окно Терминала и компьютер не спит.
 * Бесплатно, без регистрации. Нужен cloudflared: если его нет, скрипт скачает его через npx.
 * На Mac можно поставить заранее: brew install cloudflared
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PORT = process.env.PORT || '3000';
const root = path.join(__dirname, '..');

const server = spawn(process.execPath, ['--no-warnings', path.join(root, 'server', 'index.js')], {
  cwd: root, env: { ...process.env, PORT, TRUST_PROXY: '1' }, stdio: 'inherit',
});

const hasLocal = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status === 0;
const [cmd, args] = hasLocal
  ? ['cloudflared', []]
  : [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'cloudflared@0.7.3']];
if (!hasLocal) console.log('⏳ Скачиваю cloudflared (один раз, ~30 МБ)…');

const tunnel = spawn(cmd, [...args, 'tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { cwd: root });
let shown = false;
const onData = (buf) => {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(buf));
  if (m && !shown) {
    shown = true;
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  🌍 Ссылка на БХ Учёт (телефон, ноутбук — откуда угодно):');
    console.log(`\n     ${m[0]}\n`);
    console.log('  Работает, пока открыто это окно. Остановить: Ctrl + C');
    console.log('══════════════════════════════════════════════════════\n');
  }
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);
tunnel.on('exit', (code) => {
  if (!shown) {
    console.error('\n❌ Не удалось создать публичную ссылку.');
    console.error('   Установите cloudflared вручную: brew install cloudflared — и запустите npm run share ещё раз.');
    console.error(`   Сайт при этом работает локально: http://localhost:${PORT}`);
  }
  if (code && shown) console.error('Туннель закрыт.');
});

const stop = () => { tunnel.kill(); server.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
