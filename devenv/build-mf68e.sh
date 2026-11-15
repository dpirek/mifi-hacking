#!/bin/bash
# Run inside the builder container with the repository mounted at /repo.
set -euo pipefail

cd /home/builder/openwrt
cp /repo/diffconfig_mf68e .config
make defconfig
grep -qx 'CONFIG_TARGET_msm89xx_msm8916_DEVICE_generic-mf68e=y' .config
for package in configs-mifi router-display kmod-fbtft-gc9107 modem-identity luci-app-modem-identity luci-app-sms luci-theme-mifi; do
    grep -qx "CONFIG_PACKAGE_${package}=y" .config
done
make download -j8
make -j"${BUILD_JOBS:-8}" || make -j1 V=s
