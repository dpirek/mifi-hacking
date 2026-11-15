include $(TOPDIR)/rules.mk

PKG_NAME:=modem-identity
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=BSD-3-Clause

include $(INCLUDE_DIR)/package.mk

define Package/modem-identity
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=MSM8916 modem IMEI management
  DEPENDS:=+rmtfs +rpcd +jshn
endef

define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(CP) ./src/modem-identity.c $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) -std=c11 -Wall -Wextra -Werror \
		-o $(PKG_BUILD_DIR)/modem-identity $(PKG_BUILD_DIR)/modem-identity.c $(TARGET_LDFLAGS)
endef

define Package/modem-identity/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/modem-identity $(1)/usr/bin/
	$(INSTALL_BIN) ./files/modem-identity.rpc $(1)/usr/libexec/rpcd/modem-identity
endef

$(eval $(call BuildPackage,modem-identity))
