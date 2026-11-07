'use strict';

const Passkeys = {
  text(en, ro) { return document.documentElement.lang === 'ro' ? ro : en; },

  available(origin) {
    return origin === location.origin && window.isSecureContext
      && typeof window.PublicKeyCredential?.parseCreationOptionsFromJSON === 'function'
      && typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === 'function';
  },

  async ceremony(type, fields = {}) {
    const base = '/auth/passkeys/' + type;
    const { challengeId, options } = await Api.post(base + '/options', fields);
    let credential;
    try {
      credential = type === 'register'
        ? await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })
        : await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    } catch (error) {
      if (error.name === 'NotAllowedError') throw new Error(this.text('Passkey request cancelled or timed out.', 'Cererea a fost anulată sau a expirat.'));
      throw error;
    }
    if (!credential) throw new Error(this.text('No passkey was returned by the browser.', 'Browserul nu a returnat nicio cheie de acces.'));
    return Api.post(base + '/verify', { challengeId, credential: credential.toJSON() });
  },

  async loginButton(form, onLogin) {
    const button = form.querySelector('#login-passkey');
    if (!button) return;
    button.classList.add('hidden');
    const status = await Api.get('/auth/passkeys/enabled').catch(() => null);
    if (!form.isConnected || !this.available(status?.origin)) return;
    button.textContent = this.text('Sign in with a passkey', 'Autentificare cu o cheie de acces');
    button.classList.remove('hidden');
    button.addEventListener('click', async () => {
      const error = form.querySelector('#login-error');
      const submit = form.querySelector('#login-btn');
      error.classList.add('hidden');
      button.disabled = submit.disabled = true;
      try { onLogin(await this.ceremony('login')); }
      catch (err) { error.textContent = err.message; error.classList.remove('hidden'); }
      finally { button.disabled = submit.disabled = false; }
    });
  },

  async profile(el) {
    if (!el) return;
    const status = await Api.get('/auth/passkeys').catch(error => ({ error: error.message }));
    if (!el.isConnected) return;
    const available = this.available(status.origin);
    const esc = Utils.escapeHtml;
    const label = (en, ro) => esc(this.text(en, ro));
    el.innerHTML = `
      <div class="card-header"><h3><i class="fas fa-key" aria-hidden="true"></i> ${label('Passkeys', 'Chei de acces')}</h3></div>
      <div class="card-body">
        ${status.error ? `<p role="status">${esc(status.error)}</p>` : `
          <p class="text-muted">${label('Sign in with a device PIN, biometric check or security key. Existing two-step verification still applies.', 'Autentifică-te cu PIN-ul dispozitivului, date biometrice sau o cheie de securitate. Verificarea în doi pași rămâne activă.')}</p>
          ${!available ? `<p role="status">${label('Passkeys require the configured HTTPS address and a compatible browser.', 'Cheile de acces necesită adresa HTTPS configurată și un browser compatibil.')}</p>` : ''}
          ${!status.eligible ? `<p role="status">${label('Passkeys are available to local accounts with an up-to-date password.', 'Cheile de acces sunt disponibile conturilor locale cu parolă actualizată.')}</p>` : ''}
          ${status.keys.length ? `<ul>${status.keys.map(key => `<li>
            <strong>${esc(key.name)}</strong>
            <span class="text-muted">${key.last_used_at ? esc(Utils.formatDate(key.last_used_at.replace(' ', 'T') + 'Z')) : label('Unused', 'Neutilizată')}</span>
            <button type="button" class="btn btn-sm btn-danger" data-passkey="${esc(key.id)}" ${available ? '' : 'disabled'}>${label('Revoke', 'Revocă')}</button>
          </li>`).join('')}</ul>` : ''}
          ${available && status.eligible ? `<form id="passkey-add">
            <div class="form-group"><label for="passkey-name">${label('Device name', 'Numele dispozitivului')}</label>
              <input id="passkey-name" class="form-control" maxlength="80" required></div>
            <div class="form-group"><label for="passkey-password">${label('Current password', 'Parola curentă')}</label>
              <input id="passkey-password" type="password" autocomplete="current-password" class="form-control" required></div>
            <button class="btn btn-primary" type="submit">${label('Add passkey', 'Adaugă cheie de acces')}</button>
          </form>` : ''}
        `}
      </div>`;
    el.querySelector('#passkey-add')?.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('button[type=submit]');
      const password = el.querySelector('#passkey-password');
      const fields = { name: el.querySelector('#passkey-name').value, password: password.value };
      password.value = '';
      submit.disabled = true;
      try {
        await this.ceremony('register', fields);
        Toast.success(this.text('Passkey added', 'Cheie de acces adăugată'));
        await this.profile(el);
      } catch (error) { Toast.error(error.message); }
      finally { submit.disabled = false; }
    });
    el.querySelectorAll('[data-passkey]').forEach(button => button.addEventListener('click', async () => {
      if (!await Modal.confirm(this.text('Revoke this passkey?', 'Revoci această cheie de acces?'), { danger: true })) return;
      button.disabled = true;
      try {
        await Api.delete('/auth/passkeys/' + encodeURIComponent(button.dataset.passkey));
        await this.profile(el);
      } catch (error) { Toast.error(error.message); }
      finally { button.disabled = false; }
    }));
  },
};
