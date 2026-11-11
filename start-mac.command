#!/bin/bash
# БХ Учёт — запуск на MacBook с публичной ссылкой для коллег.
# Запуск: двойной клик по файлу (или в Терминале: bash start-mac.command). Остановить: закрыть окно Терминала.

cd "$(dirname "$0")" || exit 1
echo ""
echo "=== БХ Учёт ==="

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Сейчас откроется сайт nodejs.org — скачайте версию LTS, установите и запустите этот файл снова."
  open "https://nodejs.org" 2>/dev/null
  read -r -p "Нажмите Enter, чтобы закрыть…"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Нужен Node.js 22.13 или новее (сейчас $(node -v)). Установите LTS с nodejs.org и запустите снова."
  open "https://nodejs.org" 2>/dev/null
  read -r -p "Нажмите Enter, чтобы закрыть…"
  exit 1
fi

# Логин и пароль руководителя создаются один раз и хранятся в .env.local (в git не попадает).
if [ ! -f .env.local ]; then
  PASS="Bh$(node -e "console.log(require('crypto').randomInt(10000000,99999999))")"
  printf "HEAD_LOGIN=head\nHEAD_PASSWORD=%s\n" "$PASS" > .env.local
  chmod 600 .env.local
fi
set -a; . ./.env.local; set +a

# Первый запуск: можно загрузить демо-данные, чтобы сразу посмотреть аналитику.
if [ ! -f data/bh.db ]; then
  read -r -p "Загрузить демо-данные для знакомства? (д/н) " ANS
  case "$ANS" in д|Д|y|Y|да|Да) export DEMO=1 ;; esac
fi

echo "Устанавливаю (первый раз — минута)…"
npm install --no-audit --no-fund --loglevel=error || { read -r -p "Ошибка установки. Enter — закрыть…"; exit 1; }

echo ""
echo "======================================================"
echo "  Вход руководителя:  логин $HEAD_LOGIN   пароль $HEAD_PASSWORD"
if [ "$DEMO" = "1" ]; then echo "  (демо: пароль head и сотрудников — demo12345)"; fi
echo "  На этом Mac: http://localhost:3000"
echo "  Публичная ссылка для коллег появится ниже через несколько секунд."
echo "  Сотрудников добавляйте в разделе «Команда» — каждый получит свой логин."
echo "  Чтобы остановить — закройте это окно."
echo "======================================================"
echo ""
exec node scripts/share.js
