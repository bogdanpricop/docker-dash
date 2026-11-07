'use strict';

const fs = require('node:fs');
const Docker = require('dockerode');
const config = require('../config');
const dockerService = require('./docker');

async function applicationImage(docker) {
  const findSelf = async client => (await client.listContainers())
    .find(container => dockerService.isSelf(container.Id))?.ImageID;
  const image = await findSelf(docker);
  if (image || !fs.existsSync(config.docker.socketPath)) return image;
  const runtime = new Docker({ socketPath: config.docker.socketPath, timeout: 5_000 });
  const localImage = await findSelf(runtime);
  if (!localImage) return null;
  try { return (await docker.getImage(localImage).inspect()).Id === localImage ? localImage : null; }
  catch (error) { if (error.statusCode !== 404) throw error; return null; }
}

module.exports = { applicationImage };
