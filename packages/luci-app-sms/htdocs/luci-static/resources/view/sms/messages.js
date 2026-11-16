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
function known(value) { return value && value !== '--' ? value : ''; }
function contactKey(value) { return value.replace(/[\s()-]/g, '').toLowerCase(); }
function messageTime(message) {
 var value = Date.parse(message.properties.timestamp);
 return Number.isFinite(value) ? value : 0;
}
function outgoing(message) { return ['sent', 'sending', 'stored'].indexOf(message.properties.state) !== -1; }
function translationParts(items) {
 var parts = [], current = '', size = 0;
 items.forEach(function(message) {
  var value = known(message.content.text);
  if (!value) return;
  value = (current ? '\n\n' : '') + value;
  for (var character of Array.from(value)) {
   var length = encodeURIComponent(character).length;
   if (size + length > 6000) { parts.push(current); current = ''; size = 0; }
   current += character; size += length;
  }
 });
 if (current) parts.push(current);
 return parts;
}
function iconButton(label, icon, click) {
 return E('button', { 'type': 'button', 'class': 'sms-icon-button', 'aria-label': label, 'title': label, 'click': click }, E('span', { 'class': 'sms-icon sms-icon-' + icon, 'aria-hidden': 'true' }));
}

return view.extend({
 render: function() {
  var busy = false, refreshing = false, ready = false, selected = null;
  var messages = [], confirmed = [], drafts = {}, signature = '', lastError = '';
  var root, conversationList, timeline, heading, recipientRow, sendButton, refreshButton, translateButton;
  var feedback = E('p', { 'class': 'sms-feedback', 'role': 'status', 'aria-live': 'polite' });
  var connection = E('span', { 'class': 'sms-connection sms-sr-only', 'role': 'status' }, _('Connecting…'));
  var number = E('input', { 'id': 'sms-number', 'type': 'tel', 'autocomplete': 'tel', 'placeholder': '+1234567890', 'maxlength': 21 });
  var text = E('textarea', { 'id': 'sms-text', 'rows': 1, 'maxlength': 4096, 'placeholder': _('Write a message…'), 'aria-label': _('Message') });
  var search = E('input', { 'type': 'search', 'class': 'sms-search', 'placeholder': _('Search messages'), 'aria-label': _('Search messages') });
  var newButton = iconButton(_('New message'), 'compose', function() { openConversation('', true); });
  function threads() {
   var groups = {};
   messages.forEach(function(message) {
    var contact = known(message.content.number) || _('Unknown number');
    var key = contactKey(contact);
    if (!groups[key]) groups[key] = { key: key, number: contact, items: [] };
    groups[key].items.push(message);
   });
   return Object.keys(groups).map(function(key) {
    var group = groups[key];
    group.items.sort(function(a, b) { return messageTime(a) - messageTime(b) || Number(a.id) - Number(b.id); });
    group.last = group.items[group.items.length - 1];
    return group;
   }).sort(function(a, b) { return messageTime(b.last) - messageTime(a.last) || Number(b.last.id) - Number(a.last.id); });
  }
  function resizeComposer() {
   text.style.height = 'auto';
   text.style.height = Math.min(150, Math.max(52, text.scrollHeight + 2)) + 'px';
   text.style.overflowY = text.scrollHeight + 2 > 150 ? 'auto' : 'hidden';
  }
  function update() {
   var bytes = new TextEncoder().encode(text.value).length;
   sendButton.disabled = busy || refreshing || !ready || !/^\+?[0-9]{1,20}$/.test(number.value.trim()) || !text.value.trim() || bytes > 4096 || !L.hasViewPermission();
   number.disabled = text.disabled = busy;
   resizeComposer();
   newButton.disabled = busy;
   refreshButton.disabled = refreshing || busy;
   if (selected !== null) drafts[selected] = { number: number.value, text: text.value };
  }
  function renderList() {
   var query = search.value.trim().toLowerCase();
   var groups = threads().filter(function(group) {
    return group.number.toLowerCase().indexOf(query) !== -1 || group.items.some(function(message) { return (message.content.text || '').toLowerCase().indexOf(query) !== -1; });
   });
   conversationList.replaceChildren.apply(conversationList, groups.map(function(group) {
    var stamp = messageTime(group.last);
    return E('button', { 'type': 'button', 'class': 'sms-conversation' + (selected === group.key ? ' is-selected' : ''), 'aria-pressed': selected === group.key ? 'true' : 'false', 'disabled': busy || null, 'click': function() { openConversation(group.number); } }, [
     E('span', { 'class': 'sms-avatar', 'aria-hidden': 'true' }, group.number.replace(/^\+/, '').slice(-2).toUpperCase()),
     E('span', { 'class': 'sms-conversation-copy' }, [
      E('span', { 'class': 'sms-conversation-line' }, [E('strong', {}, group.number), E('time', {}, stamp ? new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')]),
      E('span', { 'class': 'sms-preview' }, group.items.length + ' ' + (group.items.length === 1 ? _('message') : _('messages')))
     ])
    ]);
   }));
   if (!groups.length) conversationList.replaceChildren(E('div', { 'class': 'sms-list-empty' }, [
    E('strong', {}, query ? _('No matches') : _('Your conversations appear here')),
    E('p', {}, query ? _('Try another number or word.') : _('Start a message or wait for an incoming SMS.'))
   ]));
  }
  function renderThread(force) {
   var group = threads().filter(function(item) { return item.key === selected; })[0];
   var items = group ? group.items : [];
   translateButton.disabled = !items.some(function(message) { return !!known(message.content.text); });
   var next = JSON.stringify([selected, items]);
   heading.textContent = selected === null ? _('Messages') : selected === '' ? _('New message') : group ? group.number : number.value;
   recipientRow.hidden = selected !== '';
   root.classList.toggle('sms-no-selection', selected === null);
   if (!force && signature === next) return;
   signature = next;
   var atBottom = force || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
   var rows = [], day = '';
   items.forEach(function(message) {
    var stamp = messageTime(message);
    var date = stamp ? new Date(stamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : _('Date unavailable');
    if (date !== day) { rows.push(E('div', { 'class': 'sms-day' }, date)); day = date; }
    var sent = outgoing(message);
    rows.push(E('article', { 'class': 'sms-message ' + (sent ? 'sms-message-out' : 'sms-message-in'), 'aria-label': sent ? _('Outgoing message') : _('Incoming message') }, [
     E('div', { 'class': 'sms-bubble' }, [
      E('div', { 'class': 'sms-message-text' }, known(message.content.text) || _('No text content (binary SMS or delivery report).')),
      E('div', { 'class': 'sms-message-meta' }, [
       E('time', {}, stamp ? new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''),
       E('span', {}, sent ? message.properties.state === 'sending' ? _('Sending') : message.properties.state === 'stored' ? _('Draft') : _('Sent') : _('Received'))
      ])
     ])
    ]));
   });
   timeline.replaceChildren.apply(timeline, rows.length ? rows : [E('div', { 'class': 'sms-thread-empty' }, [
    E('span', { 'class': 'sms-empty-mark', 'aria-hidden': 'true' }, E('span', { 'class': 'sms-icon sms-icon-chat' })),
    E('h3', {}, selected === null ? _('A little closer, one message at a time') : _('Start the conversation')),
    E('p', {}, selected === null ? _('Select a conversation on the left, or compose a new SMS.') : _('Enter a phone number and write your first message below.'))
   ])]);
   if (atBottom) timeline.scrollTop = timeline.scrollHeight;
  }
  function openConversation(recipient, focus) {
   if (busy) return;
   if (selected !== null) drafts[selected] = { number: number.value, text: text.value };
   selected = contactKey(recipient);
   var draft = drafts[selected] || { number: recipient, text: '' };
   number.value = draft.number; text.value = draft.text;
   root.classList.add('sms-thread-open');
   feedback.textContent = '';
   renderList(); renderThread(true); update();
   if (focus) number.focus();
  }
  async function refresh() {
   if (refreshing || busy) return;
   refreshing = true; update();
   try {
    var result = checked(await list());
    var items = result['modem.messaging.sms'] || (result.modem && result.modem.messaging && result.modem.messaging.sms);
    if (!Array.isArray(items)) throw new Error(_('Unexpected message list from modem.'));
    var fetched = [], errors = 0;
    // Keep modem reads sequential; a slow modem must not receive a request flood.
    for (var item of items) {
     var path = typeof item === 'string' ? item : item.path;
     var match = /^\/org\/freedesktop\/ModemManager1\/SMS\/([0-9]+)$/.exec(path || '');
     if (!match) continue;
     try {
      var message = checked(await read(match[1])).sms;
      if (!message || !message.content) throw new Error(_('Message unavailable'));
      fetched.push({ id: match[1], content: message.content, properties: message.properties || {} });
     } catch (error) { errors++; }
    }
    confirmed = confirmed.filter(function(message) { return !fetched.some(function(item) { return item.id === message.id; }); });
    messages = fetched.concat(confirmed);
    ready = true; lastError = '';
    connection.textContent = errors ? _('Some messages unavailable') : _('Up to date');
    connection.classList.remove('is-offline');
    renderList(); renderThread(false);
   } catch (error) {
    ready = false; lastError = error.message;
    connection.textContent = _('Modem unavailable');
    connection.classList.add('is-offline');
   } finally {
    refreshing = false;
    connection.title = lastError ? _('SMS unavailable: ') + lastError : _('Updates every 15 seconds');
    update();
   }
  }
  translateButton = iconButton(_('Translate conversation to English with Google'), 'translate', function() {
   var group = threads().filter(function(item) { return item.key === selected; })[0];
   var parts = translationParts(group ? group.items : []);
   if (!parts.length) return;
   function url(part) { return 'https://translate.google.com/?sl=auto&tl=en&op=translate&text=' + encodeURIComponent(part); }
   if (parts.length === 1) {
    window.open(url(parts[0]), '_blank', 'noopener,noreferrer');
   } else {
    ui.showModal(_('Translate conversation'), [
     E('p', {}, _('Open each part in Google Translate. All message text is included, in conversation order.')),
     E('div', { 'class': 'sms-translation-parts' }, parts.map(function(part,index) {
      return E('a', { 'href': url(part), 'target': '_blank', 'rel': 'noopener noreferrer' }, _('Part') + ' ' + (index+1) + ' / ' + parts.length);
     })),
     E('div', { 'class': 'right' }, E('button', { 'type': 'button', 'class': 'cbi-button', 'click': ui.hideModal }, _('Close')))
    ]);
   }
  });
  translateButton.classList.add('sms-translate');
  refreshButton = iconButton(_('Refresh messages'), 'refresh', refresh);
  sendButton = E('button', { 'type': 'button', 'class': 'sms-send', 'aria-label': _('Send SMS'), 'title': _('Send SMS'), 'disabled': true, 'click': async function() {
   if (busy || sendButton.disabled) return;
   var recipient = number.value.trim(), body = text.value;
   busy = true; update(); renderList(); feedback.textContent = _('Sending…');
   try {
    var result = checked(await send(recipient, body));
    if (!result.ok) throw new Error(_('Sending was not confirmed. Refresh before trying again.'));
    confirmed.push({ id: String(result.id), content: { number: recipient, text: body }, properties: { state: 'sent', timestamp: new Date().toISOString() } });
    messages.push(confirmed[confirmed.length - 1]);
    drafts[selected] = { number: recipient, text: '' };
    selected = contactKey(recipient); number.value = recipient; text.value = '';
    feedback.textContent = _('Sent to the network. Delivery is not confirmed.');
    renderThread(true);
   } catch (error) {
    feedback.textContent = error.message + _(' Your draft was kept. Check the conversation before sending again.');
   } finally { busy = false; update(); await refresh(); }
  } }, [E('span', { 'class': 'sms-icon sms-icon-send', 'aria-hidden': 'true' })]);
  number.addEventListener('input', update); text.addEventListener('input', update);
  text.addEventListener('keydown', function(event) {
   if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !sendButton.disabled) { event.preventDefault(); sendButton.click(); }
  });
  search.addEventListener('input', renderList);
  conversationList = E('div', { 'class': 'sms-conversation-list', 'aria-label': _('Conversations') });
  heading = E('h3');
  timeline = E('div', { 'class': 'sms-timeline', 'role': 'region', 'aria-label': _('Conversation messages'), 'tabindex': 0 });
  recipientRow = E('div', { 'class': 'sms-recipient', 'hidden': true }, [E('label', { 'for': 'sms-number' }, _('To')), number]);
  var backButton = iconButton(_('Back to conversations'), 'back', function() { root.classList.remove('sms-thread-open'); search.focus(); });
  backButton.classList.add('sms-back');
  root = E('div', { 'class': 'sms-app sms-no-selection' }, [
   E('link', { 'rel': 'stylesheet', 'href': L.resource('view/sms/messages.css') + '?v=messaging-7' }),
   E('div', { 'class': 'sms-page-heading' }, [E('h2', {}, _('Messages')), E('div', { 'class': 'sms-heading-tools' }, [search, connection])]),
   E('div', { 'class': 'sms-workspace' }, [
    E('aside', { 'class': 'sms-sidebar' }, [E('div', { 'class': 'sms-sidebar-heading' }, [E('h3', {}, _('Chats')), E('div', { 'class': 'sms-toolbar' }, [refreshButton, newButton])]), conversationList]),
    E('section', { 'class': 'sms-thread' }, [
     E('header', { 'class': 'sms-thread-heading' }, [backButton, E('span', { 'class': 'sms-avatar', 'aria-hidden': 'true' }, E('span', { 'class': 'sms-icon sms-icon-chat' })), E('div', { 'class': 'sms-thread-title' }, [heading]), translateButton]),
     timeline,
     E('div', { 'class': 'sms-composer' }, [recipientRow, E('div', { 'class': 'sms-compose-row' }, [text, sendButton]), feedback])
    ])
   ])
  ]);
  var composerWidth = 0;
  new ResizeObserver(function(entries) {
   var width = entries[0].contentRect.width;
   if (width !== composerWidth) { composerWidth = width; resizeComposer(); }
  }).observe(text);
  update(); renderList(); renderThread(true);
  poll.add(refresh, 15); refresh();
  return root;
 },
 handleSaveApply: null, handleSave: null, handleReset: null
});
