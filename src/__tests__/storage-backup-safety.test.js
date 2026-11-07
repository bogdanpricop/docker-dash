'use strict';

const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const tar = require('tar-stream');
const { normalizeArchive, bindSourceAllowed } = require('../services/storage-backup');

async function normalize(headers, fileName = 'original.txt') {
  const source = tar.pack();
  for (const header of headers) source.entry(header, header.type === 'file' ? 'content' : '');
  source.finalize();
  const { unpack, pack } = normalizeArchive(fileName);
  const chunks = [];
  await Promise.all([
    pipeline(source, unpack),
    pipeline(pack, new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } })),
  ]);
  const restored = [];
  const target = tar.extract();
  target.on('entry', (header, stream, next) => {
    const data = [];
    stream.on('data', chunk => data.push(chunk));
    stream.on('end', () => { restored.push({ ...header, content: Buffer.concat(data).toString() }); next(); });
  });
  const done = new Promise((resolve, reject) => target.once('finish', resolve).once('error', reject));
  target.end(Buffer.concat(chunks));
  await done;
  return restored;
}

describe('storage archive boundaries', () => {
  const root = { name: 'source/', type: 'directory' };

  test('retains file ownership and contained links while stripping setuid', async () => {
    const entries = await normalize([root,
      { name: 'source/file', type: 'file', uid: 1500, gid: 1700, mode: 0o4755 },
      { name: 'source/symlink', type: 'symlink', linkname: 'file' },
      { name: 'source/hardlink', type: 'link', linkname: 'source/file' },
    ]);
    expect(entries).toMatchObject([{ name: '.' },
      { name: 'file', content: 'content', uid: 1500, gid: 1700, mode: 0o755 },
      { name: 'symlink', linkname: 'file' }, { name: 'hardlink', linkname: 'file' }]);
  });

  test('a file bind retains its filename', async () => {
    const entries = await normalize([{ name: 'source', type: 'file' }]);
    expect(entries).toMatchObject([{ name: 'original.txt', content: 'content' }]);
  });

  test.each([
    { name: '/etc/passwd', type: 'file' },
    { name: 'source/../escape', type: 'file' },
    { name: 'source/link', type: 'symlink', linkname: '../escape' },
    { name: 'source/link', type: 'link', linkname: 'source/unlisted' },
    { name: 'source/unlisted/file', type: 'file' },
    { name: 'source/device', type: 'character-device' },
  ])('refuses unsafe archive entry %j', async header => {
    await expect(normalize([root, header])).rejects.toThrow(/unsafe|cannot|outside|unsupported/);
  });

  test('limits bind sources to application data directories', () => {
    for (const source of ['/', '/var/run/docker.sock', '/home/user', '/etc/shadow', '/opt/data/../file', '/tmp/docker.sock']) {
      expect(bindSourceAllowed(source)).toBe(false);
    }
    expect(bindSourceAllowed('/opt/project/data')).toBe(true);
  });
});
