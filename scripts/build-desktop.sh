#!/bin/sh
# 데스크톱(Windows) 빌드: 화면·메인 프로세스 묶기(scripts/build-desktop.mjs) → electron-builder zip
set -e
cd "$(dirname "$0")/.."
node scripts/build-desktop.mjs
cd desktop
npx electron-builder --win zip --x64 --publish never
