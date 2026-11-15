include $(TOPDIR)/rules.mk
PKG_NAME:=mifi-remote
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=BSD-3-Clause
include $(INCLUDE_DIR)/package.mk

define Package/mifi-remote
 SECTION:=net
 CATEGORY:=Network
 TITLE:=Outbound MiFi remote management agent
 DEPENDS:=+curl +ca-bundle +jshn +jsonfilter +rpcd +luci-app-sms
endef

define Package/mifi-remote/conffiles
/etc/config/mifi-remote
endef

define Build/Compile
endef

define Package/mifi-remote/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/libexec $(1)/usr/libexec/rpcd $(1)/etc/init.d $(1)/etc/config
	$(INSTALL_BIN) ./files/mifi-remote-agent $(1)/usr/bin/
	$(INSTALL_BIN) ./files/mifi-remote-dispatch $(1)/usr/libexec/
	$(INSTALL_BIN) ./files/mifi-remote.rpc $(1)/usr/libexec/rpcd/mifi-remote
	$(INSTALL_BIN) ./files/mifi-remote.init $(1)/etc/init.d/mifi-remote
	$(INSTALL_CONF) ./files/mifi-remote.config $(1)/etc/config/mifi-remote
endef
$(eval $(call BuildPackage,mifi-remote))
