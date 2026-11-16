'use strict';
(function() {
 var form = document.getElementById('mifi-login-form');
 if (!form) return;
 var password = document.getElementById('luci_password');
 var toggle = document.getElementById('mifi-password-toggle');
 var submit = document.getElementById('mifi-login-submit');
 toggle.hidden = false;
 toggle.addEventListener('click', function() {
  var visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.textContent = toggle.getAttribute(visible ? 'data-hide' : 'data-show');
  toggle.setAttribute('aria-pressed', String(visible));
 });
 form.addEventListener('submit', function() {
  submit.disabled = true;
  submit.textContent = submit.getAttribute('data-pending');
  form.setAttribute('aria-busy', 'true');
 });
 window.addEventListener('pageshow', function(event) {
  if (event.persisted) location.reload();
 });
})();
