import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionOptions, isLoopbackUrl, dispatch } from '../src/claude.js';

/**
 * El entorno de una sesión. La garantía es una sola: hacia Anthropic no va más
 * credencial que el login local, y por eso una clave en el overlay sólo se
 * acepta apuntando a un proxy de loopback, que no puede llegar a Anthropic.
 */

const withKey = (value, fn) => {
  const had = 'ANTHROPIC_API_KEY' in process.env;
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = value;
  try { fn(); } finally {
    if (had) process.env.ANTHROPIC_API_KEY = before;
    else delete process.env.ANTHROPIC_API_KEY;
  }
};

const LOOPBACK = 'http://127.0.0.1:4321/m/x';

test('sin overlay, la clave del proceso no llega a la sesión', () => {
  withKey('sk-ant-de-la-maquina', () => {
    const options = sessionOptions({ cwd: '/x', model: 'm' });
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
  });
});

test('el overlay hacia el proxy local sí lleva credencial, y no borra el resto del entorno', () => {
  withKey('sk-ant-de-la-maquina', () => {
    const options = sessionOptions({
      cwd: '/x',
      model: 'm',
      env: { ANTHROPIC_BASE_URL: LOOPBACK, ANTHROPIC_API_KEY: 'zen-proxy' },
    });
    assert.equal(options.env.ANTHROPIC_BASE_URL, LOOPBACK);
    assert.equal(options.env.ANTHROPIC_API_KEY, 'zen-proxy', 'el overlay se aplica DESPUÉS del borrado');
    assert.equal(options.env.PATH, process.env.PATH, 'lo demás del proceso sigue ahí');
  });
});

test('una credencial hacia fuera del loopback se rechaza, esté la URL o no', () => {
  const rejected = /only accepted towards a local proxy/;
  assert.throws(() => sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_API_KEY: 'zen-proxy', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  }), rejected);
  assert.throws(() => sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_API_KEY: 'zen-proxy' },
  }), rejected, 'sin base URL, el destino es Anthropic');
  assert.throws(() => sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_API_KEY: 'zen-proxy', ANTHROPIC_BASE_URL: 'http://127.0.0.1.evil.com/m/x' },
  }), rejected, 'un host que sólo empieza por 127.0.0.1 no es loopback');
});

test('un token de autorización cuenta igual que una clave', () => {
  assert.throws(() => sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_AUTH_TOKEN: 'zen-proxy', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  }), /only accepted towards a local proxy/);
  const ok = sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_AUTH_TOKEN: 'zen-proxy', ANTHROPIC_BASE_URL: LOOPBACK },
  });
  assert.equal(ok.env.ANTHROPIC_AUTH_TOKEN, 'zen-proxy');
});

test('isLoopbackUrl mira el host de verdad, no el principio de la cadena', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:4321/m/x'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1/m/x'), true);
  // El host real es evil.com: «127.0.0.1:1» es userinfo, no una dirección.
  assert.equal(isLoopbackUrl('http://127.0.0.1:1@evil.com/x'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com'), false);
  assert.equal(isLoopbackUrl('https://127.0.0.1:4321/m/x'), false, 'el proxy del tablero es http');
  assert.equal(isLoopbackUrl('http://localhost:4321'), false);
  assert.equal(isLoopbackUrl('https://api.anthropic.com'), false);
  assert.equal(isLoopbackUrl(undefined), false);
  assert.equal(isLoopbackUrl('no es una url'), false);
});

test('una credencial hacia un host disfrazado de loopback se rechaza', () => {
  assert.throws(() => sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_API_KEY: 'zen-proxy', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1@evil.com/x' },
  }), /only accepted towards a local proxy/);
});

/**
 * El medidor de cuota lee la ventana de la cuenta en cada mensaje. La sesión
 * del delegado corre sobre el modelo de otro proveedor: lo que diga no habla
 * de esta cuenta, y por eso `trackQuota: false` la deja fuera del medidor.
 */
test('con trackQuota:false ningún mensaje toca la cuota', () => {
  const limite = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', utilization: 0.93, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
  };

  const mudo = [];
  dispatch(limite, { onEvent: (ev) => mudo.push(ev), toolCounts: {}, trackQuota: false });
  assert.deepEqual(mudo, [], 'ni quota_warning ni nada');

  const normal = [];
  dispatch(limite, { onEvent: (ev) => normal.push(ev), toolCounts: {} });
  assert.deepEqual(normal.map((ev) => ev.kind), ['quota_warning'], 'el mismo mensaje sí cuenta en una sesión de la cuenta');
});

test('sin credencial, la URL puede ser la que sea: no hay nada que filtrar', () => {
  const options = sessionOptions({
    cwd: '/x', model: 'm', env: { ANTHROPIC_BASE_URL: 'https://un-gateway.example/api' },
  });
  assert.equal(options.env.ANTHROPIC_BASE_URL, 'https://un-gateway.example/api');
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
});

test('design pone el entrypoint de VS Code; sin design no hay ninguno, ni uno heredado', () => {
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
  try {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    assert.equal(sessionOptions({ cwd: '/x', model: 'm' }).env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(sessionOptions({ cwd: '/x', model: 'm', design: false }).env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(sessionOptions({ cwd: '/x', model: 'm', design: true }).env.CLAUDE_CODE_ENTRYPOINT, 'claude-vscode');
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
    assert.equal(sessionOptions({ cwd: '/x', model: 'm' }).env.CLAUDE_CODE_ENTRYPOINT, undefined, 'un valor heredado se borra');
    assert.equal(sessionOptions({ cwd: '/x', model: 'm', design: 'yes' }).env.CLAUDE_CODE_ENTRYPOINT, undefined, 'solo true estricto');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
  }
});
