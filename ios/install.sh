#!/bin/zsh
# 编译 Release 版并装到 iPhone。免费开发者账号的签名 7 天过期，过期后重新跑一次即可，登录状态不受影响。
# 用法：./install.sh            装到用数据线连着（或已配对在同一 Wi-Fi）的第一台 iPhone
#       ./install.sh <UDID>     装到指定设备（xcrun devicectl list devices 查看）
# 签名用的 Team ID 从环境变量 MUSE_TEAM_ID 或本目录的 .team 文件读取（不提交到仓库）。
set -e
cd "$(dirname "$0")"

export MUSE_TEAM_ID=${MUSE_TEAM_ID:-$(cat .team 2>/dev/null)}
[[ -n $MUSE_TEAM_ID ]] || { echo "缺少 Team ID：设置 MUSE_TEAM_ID，或写进 ios/.team"; exit 1; }

DEVICE=${1:-$(xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /iPhone/ && /(connected|available)/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')}
[[ -n $DEVICE ]] || { echo "没找到已连接的 iPhone"; exit 1; }

xcodegen generate --quiet
xcodebuild -project MusePanel.xcodeproj -scheme MusePanel -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/dd \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build | grep -E "error|BUILD"
xcrun devicectl device install app --device "$DEVICE" build/dd/Build/Products/Release-iphoneos/MusePanel.app
echo "已安装到 $DEVICE。签名有效期 7 天。"
