'use strict';
'require baseclass';
'require ui';
'require rpc';
'require poll';

return baseclass.extend({
	__init__: function() {
		var indicators = document.querySelector('#indicators');
		if (indicators) {
			var labelStatus = function() {
				var status = indicators.querySelector('[data-indicator="poll-status"]');
				if (status && status.title !== status.textContent) status.title = status.textContent;
			};
			new MutationObserver(labelStatus).observe(indicators, { childList: true, subtree: true, characterData: true });
			labelStatus();
		}
		this.setupStatus();
		ui.menu.load().then(this.render.bind(this));
	},

	setupStatus: function() {
		var page = document.body.getAttribute('data-page');
		var action = L.env.nodespec && L.env.nodespec.action;
		if ((!action || action.path !== 'admin_status/index') &&
			['admin', 'admin-status', 'admin-status-overview'].indexOf(page) === -1) return;
		document.body.setAttribute('data-page', 'admin-status-overview');
		var main = document.querySelector('#maincontent');
		var summary, sequence = 0;
		var status = rpc.declare({ object: 'mifi-status', method: 'status' });
		function control(section, heading, content, original) {
			var title = Array.from(heading.childNodes).filter(function(node) { return node !== original; }).map(function(node) { return node.textContent; }).join('').trim();
			var button = E('button', { 'type': 'button', 'class': 'mifi-panel-toggle' },
				E('span', { 'aria-hidden': 'true' }));
			content.id = content.id || 'mifi-panel-' + (++sequence);
			button.setAttribute('aria-controls', content.id);
			function sync() {
				var hidden = original ? original.getAttribute('data-style') === 'active' : content.hidden;
				section.classList.toggle('mifi-panel-collapsed', hidden);
				button.setAttribute('aria-expanded', hidden ? 'false' : 'true');
				button.setAttribute('aria-label', (hidden ? _('Show') : _('Hide')) + ' ' + title);
				button.title = button.getAttribute('aria-label');
			}
			if (original) {
				original.hidden = true;
				new MutationObserver(sync).observe(original, { attributes: true, attributeFilter: ['data-style'] });
			} else content.hidden = localStorage.getItem(title) === 'hide';
			button.addEventListener('click', function() {
				if (original) original.click();
				else {
					content.hidden = !content.hidden;
					if (content.hidden) localStorage.setItem(title, 'hide');
					else localStorage.removeItem(title);
				}
				sync();
			});
			heading.appendChild(button);
			section.setAttribute('data-mifi-panel', 'true');
			sync();
		}
		function enhance() {
			main.querySelectorAll('.cbi-section:not([data-mifi-panel])').forEach(function(section) {
				var original = section.querySelector(':scope > .cbi-title [data-clickable]');
				if (original) {
					var heading = original.parentNode;
					control(section, heading, section.children[1], original);
				} else {
					var legend = section.querySelector(':scope > legend');
					if (!legend) return;
					var heading = E('h3', {}, legend.textContent);
					var title = E('div', { 'class': 'cbi-title' }, heading);
					var content = E('div');
					legend.replaceWith(title);
					while (title.nextSibling) content.appendChild(title.nextSibling);
					section.appendChild(content);
					control(section, heading, content, null);
				}
			});
			var heading = main.querySelector('h2');
			if (!summary && heading) {
				summary = E('dl', { 'class': 'mifi-status-summary', 'aria-label': _('Router summary') });
				heading.after(summary);
				poll.add(function() {
					return status().then(function(data) {
						function available(v) { return v && v !== '--' ? v : _('Unavailable'); }
						var entries = [
							[_('Battery'), data.battery >= 0 ? (data.estimated ? '~' : '') + data.battery + '%' + (data.charging ? ' · ' + _('Charging') : '') : _('Unavailable')],
							[_('IMEI'), available(data.imei)],
							[_('Wi-Fi name'), (data.wifi || []).join(', ') || _('Disabled')],
							[_('Connected clients'), data.clients == null ? _('Unavailable') : String(data.clients)],
							[_('Mobile network'), data.operator && data.operator !== '--' ? data.operator : available(data.state)],
							[_('Signal'), data.state === 'registered' || data.state === 'connected' ? (data.signal >= 0 ? data.signal + '%' : _('Unavailable')) : _('No service')]
						];
						if (data.phone && data.phone !== '--') entries.splice(4, 0, [_('Phone number'), data.phone]);
						summary.replaceChildren.apply(summary, entries.map(function(entry) {
							return E('div', {}, [E('dt', {}, entry[0]), E('dd', {}, entry[1])]);
						}));
					}).catch(function() { summary.textContent = _('Router summary temporarily unavailable'); });
				}, 10);
			}
		}
		new MutationObserver(enhance).observe(main, { childList: true, subtree: true });
		enhance();
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
