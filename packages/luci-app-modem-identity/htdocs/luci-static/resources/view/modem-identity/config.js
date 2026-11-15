'use strict';
'require view';
'require rpc';
'require ui';

var status = rpc.declare({ object: 'modem-identity', method: 'status' });
var change = rpc.declare({ object: 'modem-identity', method: 'change', params: ['imei', 'expected'] });
var mode = rpc.declare({ object: 'modem-identity', method: 'write_mode', params: ['enabled'] });
var restore = rpc.declare({ object: 'modem-identity', method: 'restore', params: ['backup', 'expected'] });

function validIMEI(value) {
	if (!/^[0-9]{15}$/.test(value) || /^0+$/.test(value)) return false;
	var sum = 0;
	for (var i = 0; i < 15; i++) {
		var digit = Number(value[i]);
		if (i % 2) { digit *= 2; if (digit > 9) digit -= 9; }
		sum += digit;
	}
	return sum % 10 === 0;
}

function generateIMEI(current) {
	if (!validIMEI(current)) throw new Error(_('Refresh the current IMEI before generating a new one.'));
	// Keep the device's type allocation code; randomize its six-digit serial.
	var result;
	do {
		var digits = current.slice(0, 8);
		while (digits.length < 14) {
			var random = new Uint8Array(16);
			crypto.getRandomValues(random);
			for (var i = 0; i < random.length && digits.length < 14; i++)
				if (random[i] < 250) digits += String(random[i] % 10);
		}
		var sum = 0;
		for (var j = 0; j < digits.length; j++) {
			var digit = Number(digits[j]);
			if (j % 2) { digit *= 2; if (digit > 9) digit -= 9; }
			sum += digit;
		}
		result = digits + String((10 - sum % 10) % 10);
	} while (result === current);
	return result;
}

function bounded(request, timeout) {
	return new Promise(function(resolve, reject) {
		var timer = setTimeout(function() { reject(new Error(_('The modem request timed out. Refresh status before trying again.'))); }, timeout);
		Promise.resolve(request).then(function(value) { clearTimeout(timer); resolve(value); }, function(error) { clearTimeout(timer); reject(error); });
	});
}

function checked(result) {
	if (!result || result.error) throw new Error(result && result.error || _('No response from modem identity service'));
	return result;
}

return view.extend({
	load: function() { return bounded(status(), 12000).catch(function(error) { return { error: error.message }; }); },
	render: function(data) {
		var busy = false, step = -1, phase = '', verified = false, failed = false;
		var controls = [];
		var root;
		var current = E('span', { 'class': 'mi-identifier', 'id': 'mi-current' }, data.imei || _('Unavailable'));
		var badge = E('span', { 'class': 'mi-badge' });
		var storageTitle = E('h3', { 'class': 'mi-storage-title' });
		var storageText = E('p', { 'class': 'mi-description' });
		var steps = [_('Prepare modem'), _('Save identity'), _('Restart & verify')].map(function(label) {
			return E('li', { 'class': 'mi-step' }, label);
		});
		var feedback = E('div', { 'class': 'mi-feedback', 'role': 'status', 'aria-live': 'polite', 'hidden': true });
		var inputHelp = E('p', { 'class': 'mi-field-help', 'id': 'mi-imei-help', 'aria-live': 'polite' });
		var input = E('input', {
			'class': 'mi-input mi-imei-input', 'id': 'mi-new-imei', 'type': 'text',
			'maxlength': 15, 'inputmode': 'numeric', 'autocomplete': 'off', 'spellcheck': 'false',
			'placeholder': _('Enter 15 digits'), 'aria-describedby': 'mi-imei-help',
			'input': function() { update(); }
		});
		var backup = E('input', {
			'class': 'mi-input mi-backup-input', 'id': 'mi-backup', 'type': 'text',
			'autocomplete': 'off', 'spellcheck': 'false', 'placeholder': 'item550-123-456.nv',
			'aria-describedby': 'mi-backup-help', 'input': function() { update(); }
		});
		var savedName = E('code', { 'class': 'mi-backup-name' });
		var savedBackup = E('div', { 'class': 'mi-saved-backup', 'hidden': true }, [
			E('span', { 'class': 'mi-eyebrow' }, _('Backup saved')), savedName
		]);

		function button(label, action, className, handler) {
			var node = E('button', {
				'type': 'button', 'class': 'mi-button ' + (className || ''), 'data-action': action,
				'click': handler
			}, label);
			controls.push(node);
			return node;
		}
		function message(text, tone) {
			feedback.hidden = false;
			feedback.className = 'mi-feedback mi-feedback-' + (tone || 'info');
			feedback.textContent = text;
		}
		function adopt(result) {
			data = result;
			current.textContent = result.imei || _('Unavailable');
			update();
			return result;
		}
		function progress(index, text) {
			step = index;
			phase = text;
			message(text, 'info');
			update();
		}
		function update() {
			var valid = validIMEI(input.value);
			var filenameValid = /^item550-[A-Za-z0-9._-]+\.nv$/.test(backup.value);
			controls.forEach(function(node) { node.disabled = busy; });
			changeButton.disabled = busy || !!data.mode_changing || !!data.commit_pending || !data.imei || !valid;
			restoreButton.disabled = busy || !!data.mode_changing || !!data.commit_pending || !data.imei || !filenameValid;
			generateButton.disabled = busy || !validIMEI(data.imei);
			modeButton.hidden = !data.persistent_writes && !data.mode_error;
			modeButton.disabled = busy || !!data.mode_changing;
			modeButton.textContent = data.commit_pending ? _('Finish saving & restart') : _('Finish & restart');
			input.disabled = busy;
			backup.disabled = busy;
			if (root) root.setAttribute('aria-busy', busy ? 'true' : 'false');
			badge.className = 'mi-badge ' + (busy || data.mode_changing ? 'mi-badge-pending' : data.persistent_writes ? 'mi-badge-editing' : data.imei ? 'mi-badge-locked' : 'mi-badge-offline');
			badge.textContent = busy ? _('Working…') : data.mode_changing ? _('Restarting') : data.persistent_writes ? _('Editing enabled') : data.imei ? _('Read-only') : _('Unavailable');
			storageTitle.textContent = busy ? phase : failed ? _('Action needs attention') : verified ? _('Change verified') : _('Automatic modem setup');
			storageText.textContent = busy
				? _('Keep this page open. The cellular connection may briefly disconnect; progress updates automatically.')
				: data.persistent_writes ? _('Editing was left enabled. Apply your change, or finish editing to return to read-only mode.')
				: _('Enter or generate an IMEI, then choose “Apply & restart”. Modem setup, backup, restart and verification happen automatically.');
			steps.forEach(function(node, index) {
				node.className = 'mi-step' + (step > index ? ' mi-step-complete' : step === index ? failed ? ' mi-step-error' : ' mi-step-active' : '');
				node.setAttribute('aria-current', busy && step === index ? 'step' : 'false');
			});
			input.setAttribute('aria-invalid', input.value && !valid ? 'true' : 'false');
			inputHelp.className = 'mi-field-help' + (input.value && !valid ? ' mi-field-error' : '');
			inputHelp.textContent = input.value && !valid
				? input.value.length < 15 ? _('%s of 15 digits entered').format(input.value.length) : _('Check the digits. The IMEI check digit is not valid.')
				: valid ? _('Valid IMEI format') : _('Use all 15 digits, including the check digit.');
		}
		async function readStatus() {
			return checked(await bounded(status(), 12000));
		}
		async function waitForModem(writable) {
			var deadline = Date.now() + 90000;
			var lastError = '';
			for (var attempt = 0; attempt < 45 && Date.now() < deadline; attempt++) {
				await new Promise(function(resolve) { setTimeout(resolve, 2000); });
				var result;
				try { result = await readStatus(); }
				catch (error) { lastError = error.message; continue; }
				adopt(result);
				if (result.mode_error) throw new Error(result.mode_error);
				if (result.imei && !result.mode_changing && (writable === null || !!result.persistent_writes === writable)) return result;
			}
			throw new Error(_('The modem did not become ready within 90 seconds. Refresh status to check it; no write will be retried automatically.') + (lastError ? ' ' + lastError : ''));
		}
		async function refresh() {
			verified = false;
			step = -1;
			var result;
			if (data.mode_changing) {
				progress(0, _('Waiting for the modem…'));
				result = await waitForModem(null);
			} else result = adopt(await readStatus());
			if (result.mode_error) throw new Error(result.mode_error);
			message(_('Status updated.'), 'info');
			return result;
		}
		function perform(action) {
			if (busy) return Promise.resolve();
			busy = true;
			failed = false;
			update();
			return Promise.resolve().then(action).catch(function(error) {
				failed = true;
				message(error.message, 'error');
				ui.addNotification(null, E('p', {}, error.message), 'error');
			}).finally(function() { busy = false; phase = ''; update(); });
		}
		function rememberBackup(result) {
			var filename = (result && result.backup || '').split('/').pop();
			if (!filename) return;
			savedName.textContent = filename;
			savedBackup.hidden = false;
			backup.value = filename;
		}
		async function waitForStorage(marker) {
			var deadline = Date.now() + 300000;
			var lastError = '';
			for (var attempt = 0; attempt < 150 && Date.now() < deadline; attempt++) {
				progress(1, _('Waiting for modem storage to save… %s seconds remaining').format(Math.max(1, Math.ceil((deadline - Date.now()) / 1000))));
				await new Promise(function(resolve) { setTimeout(resolve, 2000); });
				var result;
				try { result = await readStatus(); }
				catch (error) { lastError = error.message; continue; }
				adopt(result);
				if (result.imei !== marker.commit_imei) throw new Error(_('The modem identity changed while waiting for storage. Check the current identity before continuing.'));
				if (!result.commit_pending && !result.persistent_writes && !result.mode_changing) return result;
				if (result.storage_pid !== marker.commit_pid) throw new Error(_('Modem storage restarted before the save was acknowledged. Check the current identity.'));
				if (result.storage_error) throw new Error(_('Modem storage reported a write error. Editing remains enabled; the backup was retained.'));
				if (result.storage_write_seq > marker.commit_seq && result.storage_write_bytes > marker.commit_bytes) return result;
			}
			throw new Error(_('The modem has not acknowledged its storage write yet. Editing remains enabled to preserve the live value. Choose “Finish saving & restart” to keep waiting; no IMEI write will be repeated.') + (lastError ? ' ' + lastError : ''));
		}
		async function finishReadOnly() {
			if (data.commit_pending) await waitForStorage(Object.assign({}, data));
			progress(2, _('Restarting modem and checking saved identity…'));
			checked(await bounded(mode(false), 12000));
			return await waitForModem(false);
		}
		async function applyIdentity(restoring) {
			var target = input.value, filename = backup.value;
			if (restoring ? !/^item550-[A-Za-z0-9._-]+\.nv$/.test(filename) : !validIMEI(target))
				throw new Error(restoring ? _('Enter a valid backup filename.') : _('Enter a valid 15-digit IMEI, including its check digit.'));
			if (!data.imei) throw new Error(_('Refresh the modem status first.'));
			verified = false;
			var expected = data.imei;
			progress(0, _('Checking current modem identity…'));
			var before = adopt(await readStatus());
			if (before.mode_changing) before = await waitForModem(null);
			if (before.imei !== expected) throw new Error(_('The current IMEI changed. Review the updated identity before applying again.'));
			var result, failure, after;
			var closeMode = !!before.persistent_writes;
			try {
				if (!restoring && target === before.imei) result = { changed: false, imei: target };
				else {
					if (!before.persistent_writes) {
						closeMode = true;
						progress(0, _('Preparing modem for editing…'));
						checked(await bounded(mode(true), 12000));
						before = await waitForModem(true);
						if (before.imei !== expected) throw new Error(_('The modem identity changed during setup. No write was attempted.'));
					}
					progress(1, restoring ? _('Backing up and restoring identity…') : _('Backing up and saving new identity…'));
					// Send exactly one write request. An ambiguous result is never retried.
					result = await bounded(restoring ? restore(filename, expected) : change(target, expected), 35000);
					rememberBackup(result);
					checked(result);
					if (!validIMEI(result.imei)) throw new Error(_('The modem did not return a valid identity after saving.'));
					if (result.commit_pending) {
						data = Object.assign({}, data, result);
						update();
					}
				}
			} catch (error) { failure = error; }
			if (closeMode) {
				try { after = await finishReadOnly(); }
				catch (error) { failure = new Error((failure ? failure.message + ' ' : '') + _('Could not complete restart and verification: ') + error.message); }
			} else after = before;
			if (failure) throw failure;
			if (after.imei !== result.imei) throw new Error(_('The IMEI did not survive the modem restart. The current identity is shown above; your backup was retained.'));
			verified = !!result.changed;
			step = 3;
			if (!restoring) input.value = '';
			message(result.changed ? _('IMEI saved and verified after restart. The modem is back in read-only mode.') : _('This IMEI is already set. No change was needed.'), result.changed ? 'success' : 'info');
		}

		var refreshButton = button(_('Refresh status'), 'refresh', 'mi-button-quiet', function() { return perform(refresh); });
		var modeButton = button(_('Finish & restart'), 'mode', 'mi-button-secondary', function() {
			return perform(async function() {
				var expected = data.commit_imei || data.imei;
				var result = await finishReadOnly();
				if (result.imei !== expected) throw new Error(_('The saved identity did not survive restart. Your backup was retained.'));
				step = 3;
				message(_('Editing finished. The modem is ready in read-only mode.'), 'success');
			});
		});
		var generateButton = button(_('Generate IMEI'), 'generate', 'mi-button-secondary', function() {
			if (busy) return;
			try {
				input.value = generateIMEI(data.imei);
				update();
				message(_('Random IMEI generated. Choose “Apply & restart” to save and verify it.'), 'info');
			} catch (error) { message(error.message, 'error'); }
		});
		var changeButton = button(_('Apply & restart'), 'change', 'mi-button-primary', function() {
			return perform(function() { return applyIdentity(false); });
		});
		var restoreButton = button(_('Restore & restart'), 'restore', 'mi-button-secondary', function() {
			return perform(function() { return applyIdentity(true); });
		});
		root = E('section', { 'class': 'modem-identity-page', 'aria-label': _('Modem identity') }, [
			E('link', { 'rel': 'stylesheet', 'href': L.resource('view/modem-identity/config.css') + '?v=storage-commit-3' }),
			E('div', { 'class': 'mi-page-header' }, [
				E('div', {}, [E('p', { 'class': 'mi-eyebrow' }, _('NETWORK / DEVICE')), E('h2', {}, _('Modem identity'))]),
				refreshButton
			]),
			E('section', { 'class': 'mi-hero', 'aria-labelledby': 'mi-current-label' }, [
				E('div', { 'class': 'mi-hero-top' }, [E('span', { 'class': 'mi-device-mark', 'aria-hidden': 'true' }, 'ID'), badge]),
				E('p', { 'class': 'mi-hero-label', 'id': 'mi-current-label' }, _('Current IMEI')),
				current,
				E('p', { 'class': 'mi-hero-meta' }, _('MSM8916 · OpenWrt'))
			]),
			feedback,
			E('div', { 'class': 'mi-grid' }, [
				E('section', { 'class': 'mi-card mi-change', 'aria-labelledby': 'mi-change-heading' }, [
					E('p', { 'class': 'mi-eyebrow' }, _('1 / CHOOSE A NEW IDENTITY')),
					E('h3', { 'id': 'mi-change-heading' }, _('Change your IMEI')),
					E('p', { 'class': 'mi-description' }, _('Enter or generate an IMEI. Apply & restart backs up the original, saves your change, and checks it after restart.')),
					E('label', { 'class': 'mi-label', 'for': 'mi-new-imei' }, _('New IMEI')),
					input, inputHelp,
					E('div', { 'class': 'mi-change-actions' }, [generateButton, changeButton]),
					savedBackup
				]),
				E('section', { 'class': 'mi-card mi-storage', 'aria-labelledby': 'mi-storage-heading' }, [
					E('p', { 'class': 'mi-eyebrow', 'id': 'mi-storage-heading' }, _('AUTOMATIC PROGRESS')),
					storageTitle, storageText, E('ol', { 'class': 'mi-steps' }, steps), modeButton,
					E('p', { 'class': 'mi-fine-print' }, _('The page checks readiness automatically. A failed write is never retried for you.'))
				])
			]),
			E('details', { 'class': 'mi-card mi-restore' }, [
				E('summary', {}, [E('span', { 'class': 'mi-restore-heading' }, _('Restore a previous IMEI')), E('span', { 'class': 'mi-chevron', 'aria-hidden': 'true' })]),
				E('div', { 'class': 'mi-restore-body' }, [
					E('p', { 'class': 'mi-description' }, _('Use a saved backup to return to a previous identity. Your current identity will also be backed up.')),
					E('label', { 'class': 'mi-label', 'for': 'mi-backup' }, _('Backup filename')),
					E('div', { 'class': 'mi-restore-controls' }, [backup, restoreButton]),
					E('p', { 'class': 'mi-field-help', 'id': 'mi-backup-help' }, _('Backups are saved in /etc/modem-identity-backups. Restore & restart handles modem setup and verification automatically.'))
				])
			])
		]);
		update();
		if (data.mode_changing) perform(refresh);
		else if (data.commit_pending) perform(async function() {
			var expected = data.commit_imei;
			var result = await finishReadOnly();
			if (result.imei !== expected) throw new Error(_('The saved identity did not survive restart. Your backup was retained.'));
			step = 3;
			message(_('IMEI saved and verified after restart. The modem is back in read-only mode.'), 'success');
		});
		else if (data.error) message(data.error, 'error');
		return root;
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
