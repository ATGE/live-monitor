import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serviceEnv } from '../src/stack-env.js';

const hfs = { label: 'HFS', portEnv: 'HFS_SERVER_PORT', env: { HFS_SERVER_HOST: '0.0.0.0' } };
const hts = { label: 'HTS', portEnv: 'HTS_SERVER_PORT', env: { HTS_SERVER_HOST: '0.0.0.0' } };

// #1069: without its own base URL a task's HFS sent Bulk Import to
// http://localhost:8080 — another server, or nothing — and the import failed.
test('a task HFS points its base URL at its own port', () => {
  assert.deepEqual(serviceEnv('hfs', hfs, 18080), {
    HFS_SERVER_HOST: '0.0.0.0',
    HFS_SERVER_PORT: '18080',
    HFS_BASE_URL: 'http://127.0.0.1:18080',
  });
});

test('a configured HFS_BASE_URL is left alone', () => {
  const spec = { ...hfs, env: { ...hfs.env, HFS_BASE_URL: 'https://hfs.example' } };
  assert.equal(serviceEnv('hfs', spec, 18082).HFS_BASE_URL, 'https://hfs.example');
});

test('other services get no HFS base URL, and extras still ride along', () => {
  assert.deepEqual(serviceEnv('hts', hts, 18081, { HTS_DATABASE_URL: './data/hts.db' }), {
    HTS_SERVER_HOST: '0.0.0.0',
    HTS_DATABASE_URL: './data/hts.db',
    HTS_SERVER_PORT: '18081',
  });
});

test('the launch port always wins over a stale one in the config', () => {
  const spec = { ...hfs, env: { ...hfs.env, HFS_SERVER_PORT: '9999' } };
  assert.equal(serviceEnv('hfs', spec, 18090).HFS_SERVER_PORT, '18090');
});
