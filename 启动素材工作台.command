#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请安装 Node.js 24 LTS 后再次双击。"
  read -r -p "按回车关闭…"
  exit 1
fi
node scripts/launch.mjs
if [ $? -ne 0 ]; then read -r -p "启动失败，按回车关闭…"; fi
