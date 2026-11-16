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
		var self = this;
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
				self.setupPing(summary);
				poll.add(function() {
					return status().then(function(data) {
						function available(v) { return v && v !== '--' ? v : _('Unavailable'); }
						var metrics = data.metrics || {}, sms = data.sms || {};
						function bytes(value) {
							if (value == null || value < 0) return _('Unavailable');
							var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], index = 0;
							while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
							return (index ? value.toFixed(1) : Math.round(value)) + ' ' + units[index];
						}
						function transfer(rate, total) {
							return E('span', {}, [
								E('span', {}, rate >= 0 ? bytes(rate) + '/s' : _('Measuring…')),
								E('small', {}, bytes(total) + ' ' + _('since boot') + (metrics.traffic_device ? ' · ' + metrics.traffic_device : ''))
							]);
						}
						var smsLink = E('a', { 'href': L.url('admin', 'network', 'sms') },
							typeof sms.unread === 'number' ? _('Messages') + ' · ' + sms.unread + ' ' + _('unread') : _('Messages') + ' · ' + _('count unavailable'));
						smsLink.title = _('Unread received messages not yet opened in the SMS page. Read tracking resets when the router reboots.');
						var entries = [
							[_('Download'), transfer(metrics.download_rate, metrics.download_bytes)],
							[_('Upload'), transfer(metrics.upload_rate, metrics.upload_bytes)],
							[_('CPU'), metrics.cpu >= 0 ? metrics.cpu + '%' : _('Measuring…')],
							[_('Memory'), metrics.memory >= 0 ? metrics.memory + '%' : _('Unavailable')],
							[_('VPN'), available(metrics.vpn)],
							[_('Router IP'), available(metrics.router_ip)],
							[_('Public IP'), available(metrics.public_ip)],
							[_('SMS'), smsLink],
							[_('Battery'), data.battery >= 0 ? (data.estimated ? '~' : '') + data.battery + '%' + (data.charging ? ' · ' + _('Charging') : '') : _('Unavailable')],
							[_('IMEI'), available(data.imei)],
							[_('Wi-Fi name'), (data.wifi || []).join(', ') || _('Disabled')],
							[_('Connected clients'), data.clients == null ? _('Unavailable') : String(data.clients)],
							[_('Mobile network'), data.operator && data.operator !== '--' ? data.operator : available(data.state)],
							[_('Signal'), data.state === 'registered' || data.state === 'connected' ? (data.signal >= 0 ? data.signal + '%' : _('Unavailable')) : _('No service')]
						];
						if (data.phone && data.phone !== '--') entries.splice(12, 0, [_('Phone number'), data.phone]);
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


	setupPing: function(summary) {
		var history = rpc.declare({ object: 'mifi-ping', method: 'history' });
		var canvas = E('canvas', { 'class': 'mifi-ping-canvas', 'role': 'img', 'aria-label': _('Ping response times over the last 60 minutes') });
		var details = E('p', { 'class': 'mifi-ping-details' }, _('Collecting samples…'));
		var target = E('p', { 'class': 'mifi-ping-target' }, _('Every 10 seconds · last 60 minutes'));
		var scaleLabel = E('span', { 'class': 'mifi-ping-scale' }, 'ms');
		var hover = E('span', { 'class': 'mifi-ping-hover', 'aria-live': 'polite' });
		var chart = E('section', { 'class': 'mifi-ping-chart', 'aria-label': _('Ping history') }, [
			E('div', { 'class': 'mifi-ping-heading' }, [E('div', {}, [E('h3', {}, _('Ping response')), target]), details]),
			E('div', { 'class': 'mifi-ping-plot' }, [scaleLabel, canvas]),
			E('div', { 'class': 'mifi-ping-axis' }, [E('span', {}, _('60 min ago')), E('span', {}, _('30 min')), E('span', {}, _('Now'))]),
			E('div', { 'class': 'mifi-ping-legend' }, [E('span', { 'class': 'mifi-ping-success' }, _('Response')), E('span', { 'class': 'mifi-ping-failure' }, _('Timeout')), hover])
		]);
		summary.after(chart);
		var samples = [], slots = [], now = 0, active = false;
		function draw() {
			var width = canvas.clientWidth, height = 150;
			if (!width) return;
			var dpr = window.devicePixelRatio || 1;
			canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
			var context = canvas.getContext('2d');
			context.scale(dpr, dpr);
			context.clearRect(0, 0, width, height);
			var end = Math.floor(now / 10) * 10, start = end - 3590;
			slots = new Array(360);
			var maximum = 0;
			samples.forEach(function(sample) {
				var index = Math.floor((sample.time - start) / 10);
				if (index >= 0 && index < 360) { slots[index] = sample; if (sample.ms >= 0) maximum = Math.max(maximum, sample.ms); }
			});
			var ceiling = Math.max(50, Math.ceil(maximum / 50) * 50);
			scaleLabel.textContent = ceiling + ' ms';
			context.strokeStyle = '#e9edf4'; context.lineWidth = 1;
			for (var i = 0; i < 3; i++) {
				var y = Math.round(2 + i * 73) + 0.5;
				context.beginPath(); context.moveTo(0,y); context.lineTo(width,y); context.stroke();
			}
			var cell = width / 360, bar = Math.min(cell, Math.max(0.55, cell * 0.65));
			slots.forEach(function(sample, index) {
				var h = sample.ms < 0 ? 146 : Math.max(1.5, sample.ms / ceiling * 146);
				context.fillStyle = sample.ms < 0 ? '#c45861' : '#5279cf';
				context.fillRect(index * cell + (cell - bar) / 2, 148 - h, bar, h);
			});
		}
		function inspect(event) {
			var box = canvas.getBoundingClientRect();
			var index = Math.max(0, Math.min(359, Math.floor((event.clientX - box.left) / box.width * 360)));
			var sample = slots[index];
			hover.textContent = sample ? new Date(sample.time * 1000).toLocaleTimeString() + ' · ' + (sample.ms < 0 ? _('Timeout') : sample.ms.toFixed(1) + ' ms') : '';
		}
		canvas.addEventListener('mousemove', inspect);
		canvas.addEventListener('mouseleave', function() { hover.textContent = ''; });
		new ResizeObserver(draw).observe(canvas);
		function refresh() {
			if (active) return;
			active = true;
			return history().then(function(data) {
				now = Number(data.now) || Date.now() / 1000;
				samples = (data.samples || []).filter(function(sample) { return Number.isFinite(sample.time) && Number.isFinite(sample.ms) && sample.time > now - 3600 && sample.time <= now; }).sort(function(a,b) { return a.time - b.time; });
				target.textContent = (data.target || '1.1.1.1') + ' · ' + _('every 10 seconds · last 60 minutes');
				var successes = samples.filter(function(sample) { return sample.ms >= 0; });
				var latest = samples[samples.length-1];
				var average = successes.length ? successes.reduce(function(sum,sample) { return sum + sample.ms; },0) / successes.length : 0;
				details.textContent = latest ? (latest.ms < 0 ? _('Timeout') : latest.ms.toFixed(1) + ' ms') + (successes.length ? ' · ' + _('avg') + ' ' + average.toFixed(1) + ' ms' : '') + ' · ' + Math.round((samples.length-successes.length)*100/samples.length) + '% ' + _('loss') : _('Collecting samples…');
				canvas.setAttribute('aria-label', _('Ping response times over the last 60 minutes') + '. ' + details.textContent + '. ' + samples.length + ' ' + _('samples'));
				draw();
			}).catch(function() { details.textContent = _('Ping history temporarily unavailable'); }).finally(function() { active = false; });
		}
		poll.add(refresh, 10); refresh();
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
