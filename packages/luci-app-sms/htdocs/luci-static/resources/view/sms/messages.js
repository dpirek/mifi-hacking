'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var list = rpc.declare({ object: 'sms', method: 'list' });
var read = rpc.declare({ object: 'sms', method: 'read', params: ['id'] });
var send = rpc.declare({ object: 'sms', method: 'send', params: ['number', 'text'] });

function checked(result) {
	if (!result || result.error) throw new Error(result && result.error || _('No response from SMS service.'));
	return result;
}

return view.extend({
	render: function() {
		var busy = false, refreshing = false, ready = false;
		var feedback = E('p', { 'role': 'status', 'aria-live': 'polite' });
		var inbox = E('div', {}, _('Loading messages…'));
		var number = E('input', { 'id': 'sms-number', 'type': 'tel', 'placeholder': '+1234567890', 'maxlength': 21 });
		var text = E('textarea', { 'id': 'sms-text', 'rows': 5, 'style': 'width:100%;box-sizing:border-box', 'placeholder': _('Write a message') });
		var count = E('p', { 'class': 'cbi-section-descr' });
		function update() {
			var bytes = new TextEncoder().encode(text.value).length;
			count.textContent = bytes + _(' / 4096 bytes. Long messages may use multiple SMS and incur additional charges.');
			sendButton.disabled = busy || !ready || !/^\+?[0-9]{1,20}$/.test(number.value.trim()) || !text.value.trim() || bytes > 4096 || !L.hasViewPermission();
			number.disabled = text.disabled = busy;
		}
		number.addEventListener('input', update);
		text.addEventListener('input', update);
		async function refresh() {
			if (refreshing || busy) return;
			refreshing = true;
			refreshButton.disabled = true;
			try {
				var result = checked(await list());
				var items = result['modem.messaging.sms'] || (result.modem && result.modem.messaging && result.modem.messaging.sms);
				if (!Array.isArray(items)) throw new Error(_('Unexpected message list from modem.'));
				var cards = [];
				// Read sequentially to avoid flooding the modem and RPC daemon.
				for (var item of items) {
					var path = typeof item === 'string' ? item : item.path;
					var match = /^\/org\/freedesktop\/ModemManager1\/SMS\/([0-9]+)$/.exec(path || '');
					if (!match) continue;
					try {
						var message = checked(await read(match[1])).sms;
						if (!message || !message.content) throw new Error(_('Message unavailable'));
						var content = message.content, props = message.properties || {};
						cards.push(E('article', { 'class': 'cbi-section', 'style': 'overflow-wrap:anywhere' }, [
							E('strong', {}, content.number || _('Unknown number')),
							E('p', {}, [props.state, props.timestamp !== '--' ? props.timestamp : ''].filter(Boolean).join(' · ')),
							E('div', { 'style': 'white-space:pre-wrap' }, content.text && content.text !== '--' ? content.text : _('No text content (binary SMS or delivery report).'))
						]));
					} catch (error) { cards.push(E('p', {}, _('Could not read message ') + match[1] + ': ' + error.message)); }
				}
				inbox.replaceChildren.apply(inbox, cards.length ? cards : [E('p', {}, _('No messages. Incoming and sent messages will appear here.'))]);
				ready = true;
			} catch (error) {
				ready = false;
				inbox.replaceChildren(E('p', { 'class': 'alert-message warning' }, _('SMS unavailable: ') + error.message));
			} finally { refreshing = false; refreshButton.disabled = false; update(); }
		}
		var refreshButton = E('button', { 'type': 'button', 'class': 'cbi-button', 'click': refresh }, _('Refresh messages'));
		var sendButton = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-action', 'disabled': true, 'click': async function() {
			if (busy || sendButton.disabled) return;
			busy = true;
			update();
			feedback.textContent = _('Sending…');
			try {
				var result = checked(await send(number.value.trim(), text.value));
				if (!result.ok) throw new Error(_('Sending was not confirmed. Refresh before trying again.'));
				text.value = '';
				feedback.textContent = _('Message sent to the network. Delivery to the recipient is not confirmed.');
			} catch (error) {
				feedback.textContent = error.message + _(' Your draft was kept. Check the message list before sending again.');
			} finally { busy = false; update(); await refresh(); }
		} }, _('Send SMS'));
		update();
		poll.add(refresh, 15);
		refresh();
		return E('div', {}, [
			E('h2', {}, _('SMS')),
			E('section', { 'class': 'cbi-section' }, [
				E('h3', {}, _('New message')),
				E('p', {}, [E('label', { 'for': 'sms-number' }, _('Recipient')), E('br'), number]),
				E('label', { 'for': 'sms-text' }, _('Message')), text, count, sendButton, feedback
			]),
			E('section', { 'class': 'cbi-section' }, [E('h3', {}, _('Messages')), refreshButton,
				E('p', {}, _('Updates every 15 seconds. Messages are held by the modem; they are not backed up by this page.')), inbox])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
