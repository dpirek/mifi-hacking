'use strict';
'require baseclass';
'require ui';

return baseclass.extend({
	__init__: function() {
		ui.menu.load().then(this.render.bind(this));
	},
	render: function(tree) {
		var menu = document.querySelector('#topmenu');
		if (!menu) return;
		var roots = ui.menu.getChildren(tree);
		var selected = roots.filter(function(node) { return node.name === (L.env.requestpath[0] || 'admin'); })[0] || roots[0];
		if (!selected) return;
		this.renderMainMenu(selected, selected.name, menu, 0);
		var modes = document.querySelector('#mifi-mode-menu');
		if (roots.length > 1) {
			roots.forEach(function(node) {
				modes.appendChild(E('a', { 'href': L.url(node.name) }, _(node.title)));
			});
			modes.hidden = false;
		}
		var node = tree, url = '';
		if (L.env.dispatchpath.length >= 3) {
			for (var i = 0; i < 3 && node; i++) {
				node = node.children && node.children[L.env.dispatchpath[i]];
				url += (url ? '/' : '') + L.env.dispatchpath[i];
			}
			if (node) this.renderTabMenu(node, url, 0);
		}
		this.setupDrawer();
	},
	renderMainMenu: function(tree, url, container, level) {
		ui.menu.getChildren(tree).forEach(function(child) {
			if (child.name === 'logout') return;
			var path = url + '/' + child.name;
			var active = L.env.dispatchpath.slice(0, level + 2).join('/') === path;
			var children = ui.menu.getChildren(child);
			if (children.length && level < 2) {
				var submenu = E('ul', { 'class': 'mifi-submenu' });
				this.renderMainMenu(child, path, submenu, level + 1);
				var details = E('details', { 'class': 'mifi-nav-group' }, [
					E('summary', {}, [E('span', {}, _(child.title)), E('span', { 'class': 'mifi-nav-chevron', 'aria-hidden': 'true' })]),
					submenu
				]);
				details.open = active;
				container.appendChild(E('li', {}, details));
			} else {
				var attrs = { 'href': L.url(path), 'class': 'mifi-nav-link' + (active ? ' is-active' : '') };
				if (active) attrs['aria-current'] = 'page';
				container.appendChild(E('li', {}, E('a', attrs, _(child.title))));
			}
		}, this);
	},
	renderTabMenu: function(tree, url, level) {
		var container = document.querySelector('#tabmenu');
		var children = ui.menu.getChildren(tree);
		if (!container || !children.length) return;
		var ul = E('ul', { 'class': 'tabs' }), active;
		children.forEach(function(child) {
			var selected = L.env.dispatchpath[3 + level] === child.name;
			ul.appendChild(E('li', { 'class': 'tabmenu-item-' + child.name + (selected ? ' active' : '') },
				E('a', { 'href': L.url(url, child.name) }, _(child.title))));
			if (selected) active = child;
		});
		container.appendChild(ul);
		container.style.display = '';
		if (active) this.renderTabMenu(active, url + '/' + active.name, level + 1);
	},
	setupDrawer: function() {
		var toggle = document.querySelector('#mifi-menu-toggle');
		var navigation = document.querySelector('#mifi-navigation');
		var shade = document.querySelector('#mifi-nav-shade');
		var content = document.querySelector('#maincontent');
		var mobile = window.matchMedia('(max-width: 899px)');
		var opened = false;
		function update(focus) {
			var visible = !mobile.matches || opened;
			navigation.hidden = !visible;
			shade.hidden = !mobile.matches || !opened;
			toggle.setAttribute('aria-expanded', mobile.matches && opened ? 'true' : 'false');
			document.body.classList.toggle('mifi-drawer-open', mobile.matches && opened);
			content.inert = mobile.matches && opened;
			if (focus && mobile.matches) {
				if (opened) {
					var first = navigation.querySelector('summary, a');
					if (first) first.focus();
				} else toggle.focus();
			}
		}
		toggle.addEventListener('click', function() { opened = !opened; update(true); });
		shade.addEventListener('click', function() { opened = false; update(true); });
		document.addEventListener('keydown', function(event) {
			if (event.key === 'Escape' && opened) { opened = false; update(true); }
		});
		mobile.addEventListener('change', function() { opened = false; update(false); });
		update(false);
	}
});
