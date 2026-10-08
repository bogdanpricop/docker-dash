'use strict';

const IMAGE_REFERENCE = 'com.docker-dash.image-reference';
const clone = value => JSON.parse(JSON.stringify(value));

function imageReference(inspect) {
  const configured = inspect.Config.Image;
  return /^sha256:[a-f0-9]{64}$/.test(configured)
    ? inspect.Config.Labels?.[IMAGE_REFERENCE] || configured : configured;
}

function endpoints(inspect) {
  return Object.fromEntries(Object.entries(inspect.NetworkSettings?.Networks || {}).map(([name, endpoint]) => [name, {
    ...(endpoint.IPAMConfig ? { IPAMConfig: clone(endpoint.IPAMConfig) } : {}),
    ...(endpoint.Aliases ? { Aliases: endpoint.Aliases.filter(alias => ![inspect.Id, inspect.Id.slice(0, 12)].includes(alias)) } : {}),
    ...(endpoint.DriverOpts ? { DriverOpts: clone(endpoint.DriverOpts) } : {}),
    ...(endpoint.GwPriority !== undefined ? { GwPriority: endpoint.GwPriority } : {}),
  }]));
}

function options(inspect, imageId, saved) {
  const cfg = clone(saved || inspect.Config), host = clone(saved?.HostConfig || inspect.HostConfig || {});
  delete cfg.HostConfig; delete cfg.Mounts; delete cfg.NetworkingConfig;
  // Reuse actual volume names, including Docker-generated anonymous ones.
  for (const mount of (saved?.Mounts || inspect.Mounts || []).filter(m => m.Type === 'volume' && m.Name)) {
    host.Binds = (host.Binds || []).map(bind => bind === mount.Destination ? mount.Name + ':' + bind : bind);
    const bound = (host.Binds || []).some(bind => bind.endsWith(':' + mount.Destination) || bind.includes(':' + mount.Destination + ':'));
    if (bound || (host.Mounts || []).some(m => m.Target === mount.Destination)) continue;
    (host.Mounts ||= []).push({ Type: 'volume', Source: mount.Name, Target: mount.Destination,
      ReadOnly: !mount.RW, VolumeOptions: { NoCopy: true } });
  }
  return { ...cfg, Image: imageId, HostConfig: host,
    Labels: { ...(cfg.Labels || {}), [IMAGE_REFERENCE]: imageReference({ Config: saved?.Image ? saved : inspect.Config }) },
    NetworkingConfig: saved?.NetworkingConfig || { EndpointsConfig: endpoints(inspect) } };
}

module.exports = { options, endpoints, imageReference, IMAGE_REFERENCE };
