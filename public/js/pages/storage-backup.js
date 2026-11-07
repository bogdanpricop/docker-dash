'use strict';

const StorageBackupPanel = {
  async render(el) {
    if (!el) return;
    const base = '/system/backup/storage';
    const url = (suffix = '') => base + suffix + '?hostId=0';
    const esc = Utils.escapeHtml;
    const text = (en, ro) => document.documentElement.lang === 'ro' ? ro : en;
    const [hosts, data] = await Promise.all([Api.getHosts(), Api.get(url())]).catch(error => [null, { error }]);
    if (!el.isConnected) return;
    if (!hosts) {
      el.textContent = data.error.message;
      return;
    }
    const eligible = hosts.filter(host => host.isActive && host.daemonType === 'docker');
    const selected = eligible.find(host => host.id === Api.getHostId()) || eligible.find(host => host.isDefault) || eligible[0];
    const hostOptions = eligible.map(host =>
      `<option value="${host.id}" ${host.id === selected?.id ? 'selected' : ''}>${esc(host.name)}</option>`).join('');
    const heading = text('Volume and bind mount backups', 'Backup pentru volume și bind mounts');
    el.innerHTML = `
      <div class="card-header"><h3>${heading}</h3></div>
      <div class="card-body">
        <p class="text-muted">${text(
          'Create an encrypted file backup, then restore it to a new volume on a managed Docker host. Pause writes or use an application-native dump for consistent database backups.',
          'Creează o arhivă criptată, apoi restaureaz-o într-un volum nou pe un host Docker gestionat. Pentru baze de date consistente, oprește scrierile sau folosește exportul nativ al aplicației.'
        )}</p>
        <p class="text-muted text-sm">${text('Limits: 2 GiB per archive and 8 GiB total.', 'Limite: 2 GiB pe arhivă și 8 GiB în total.')}</p>
        <form id="storage-create">
          <div class="form-group"><label for="storage-source-host">${text('Source host', 'Host sursă')}</label>
            <select class="form-control" id="storage-source-host" required>${hostOptions}</select></div>
          <div class="form-group"><label for="storage-source">${text('Volume or bind mount', 'Volum sau bind mount')}</label>
            <select class="form-control" id="storage-source" required></select></div>
          <button type="submit" class="btn btn-primary" disabled>${text('Create backup', 'Creează backup')}</button>
        </form>
        <p class="text-sm" id="storage-status" role="status"></p>
        ${data.backups.length ? `
          <hr class="divider">
          <form id="storage-restore">
            <div class="form-group"><label for="storage-archive">${text('Backup', 'Arhivă')}</label>
              <select class="form-control" id="storage-archive" required>
                ${data.backups.map(item => `<option value="${item.id}">${esc(item.host_name)} · ${esc(item.source_name)}
                  · ${esc(Utils.formatDate(item.created_at.replace(' ', 'T') + 'Z'))} · ${Utils.formatBytes(item.archive_bytes)}</option>`).join('')}
              </select></div>
            <div class="form-group"><label for="storage-target-host">${text('Destination host', 'Host destinație')}</label>
              <select class="form-control" id="storage-target-host" required>${hostOptions}</select></div>
            <div class="form-group"><label for="storage-target-name">${text('New volume name', 'Numele volumului nou')}</label>
              <input class="form-control" id="storage-target-name" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{1,127}"></div>
            <button type="submit" class="btn btn-primary">${text('Review restore', 'Verifică restaurarea')}</button>
            <button type="button" class="btn btn-danger" id="storage-delete">${text('Delete selected backup', 'Șterge arhiva aleasă')}</button>
          </form>` : `<p class="text-muted">${text('No storage backups yet.', 'Nu există încă arhive de backup.')}</p>`}
      </div>`;
    const sourceHost = el.querySelector('#storage-source-host');
    const source = el.querySelector('#storage-source');
    const status = el.querySelector('#storage-status');
    const create = el.querySelector('#storage-create');
    const createButton = create.querySelector('button');
    const archive = el.querySelector('#storage-archive');
    let generation = 0;
    let busy = false;
    const refreshSources = async () => {
      const request = ++generation;
      const sourceHostId = sourceHost.value;
      source.disabled = createButton.disabled = true;
      source.replaceChildren();
      if (!sourceHostId) return;
      status.textContent = text('Loading sources…', 'Se încarcă sursele…');
      try {
        const found = await Api.get(url('/sources') + '&sourceHostId=' + encodeURIComponent(sourceHostId));
        if (request !== generation) return;
        const optionGroup = (name, entries) => {
          const group = document.createElement('optgroup');
          group.label = name;
          for (const [label, value] of entries) {
            const option = document.createElement('option');
            option.textContent = label;
            option.value = JSON.stringify(value);
            group.appendChild(option);
          }
          source.appendChild(group);
        };
        optionGroup(text('Volumes', 'Volume'), found.volumes.map(name => [name, { type: 'volume', name }]));
        optionGroup('Bind mounts', found.binds.map(bind => [bind.containerName + ' · ' + bind.destination,
          { type: 'bind', containerId: bind.containerId, destination: bind.destination }]));
        source.disabled = createButton.disabled = source.options.length === 0;
        status.textContent = source.disabled ? text('No eligible sources on this host.', 'Hostul nu are surse eligibile.') : '';
      } catch (error) { if (request === generation) status.textContent = error.message; }
    };
    const run = async (message, action, success) => {
      if (busy) return;
      busy = true;
      const controls = [...el.querySelectorAll('button, select, input')].filter(control => !control.disabled);
      controls.forEach(control => { control.disabled = true; });
      status.textContent = message;
      try {
        const result = await action();
        const notice = success?.(result);
        if (notice) Toast.success(notice);
        if (el.isConnected) await this.render(el);
      } catch (error) { status.textContent = error.message; }
      finally {
        busy = false;
        controls.forEach(control => { control.disabled = false; });
      }
    };
    const poll = async ({ operationId }) => {
      for (let attempt = 0; attempt < 480; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const operation = await Api.get(url('/operations/' + encodeURIComponent(operationId)));
        if (operation.state === 'failed') throw new Error(operation.error);
        if (operation.state === 'completed') return operation.result;
      }
      throw new Error(text('Operation status timed out. Refresh the backup list.', 'A expirat timpul de așteptare. Actualizează lista de arhive.'));
    };
    sourceHost.addEventListener('change', refreshSources);
    void refreshSources();
    create.addEventListener('submit', event => {
      event.preventDefault();
      if (!source.value) return;
      const input = { sourceHostId: sourceHost.value, source: JSON.parse(source.value) };
      void run(text('Creating encrypted backup…', 'Se creează arhiva criptată…'),
        async () => poll(await Api.post(url(), input)), () => text('Backup created', 'Arhiva a fost creată'));
    });
    el.querySelector('#storage-restore')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const id = archive.value;
      const input = { targetHostId: el.querySelector('#storage-target-host').value, volume: el.querySelector('#storage-target-name').value };
      const restore = '/' + encodeURIComponent(id) + '/restore';
      await run(text('Checking the destination…', 'Se verifică destinația…'), async () => {
        const plan = await Api.post(url(restore + '/plan'), input);
        const accepted = await Modal.confirm(`
          <p>${esc(plan.sourceHost)} · ${esc(plan.source)}</p>
          <p>${text('New volume on', 'Volum nou pe')} <strong>${esc(plan.destinationHost)}</strong>
            · <strong>${esc(plan.volume)}</strong> · ${Utils.formatBytes(plan.archiveBytes)}</p>
        `);
        if (!accepted) return null;
        status.textContent = text('Restoring to the new volume…', 'Se restaurează în volumul nou…');
        return poll(await Api.post(url(restore), { ...input, confirmation: plan.confirmation }));
      }, result => result ? text('Volume restored', 'Volumul a fost restaurat') : null);
    });
    el.querySelector('#storage-delete')?.addEventListener('click', async () => {
      if (busy) return;
      const id = archive.value;
      if (!await Modal.confirm(text('Delete this encrypted backup?', 'Ștergi această arhivă criptată?'), { danger: true })) return;
      void run(text('Deleting backup…', 'Se șterge arhiva…'),
        () => Api.delete(url('/' + encodeURIComponent(id))), () => text('Backup deleted', 'Arhiva a fost ștearsă'));
    });
  },
};
