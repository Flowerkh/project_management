#!/bin/sh
# 데스크톱(Windows) 빌드: 화면 빌드(dist/app) → desktop/app 복사 → electron-builder zip
set -e
cd "$(dirname "$0")/.."
node scripts/build.mjs
rm -rf desktop/app
cp -r dist/app desktop/app
cp docs/사용방법.txt desktop/app/사용방법.txt 2>/dev/null || true
cd desktop
npx electron-builder --win zip --x64 --publish never
