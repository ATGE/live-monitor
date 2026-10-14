// La lectura de la cuota: cuándo reabre la ventana y por qué vía se detecta.
//
// Nada aquí duerme ni abre sesiones: `parseResetTime` recibe el «ahora» como
// parámetro y la detección es pura. El caso que dio origen a todo esto —
// «resets 4:30pm (UTC)» leído a las 16:45— está el primero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hfsmon-quota-'));
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let quota;
let PREFIXES;

before(async () => {
  quota = await import('../src/quota.js');
  ({ USAGE_LIMIT_ERROR_PREFIXES: PREFIXES } = quota);
});

after(() => {
  quota.resetQuotaForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

const utc = (h, m) => Date.UTC(2026, 8, 16, h, m);
const notice = (tail) => `You've hit your session limit · ${tail}`;

// ---------------------------------------------------------------------------
// La hora, reconstruida

test('«resets 4:30pm (UTC)» leído a las 16:45 da NULO, no mañana', () => {
  // Sin el tope de 6 h esto programaría el despertar para las 16:30 de mañana
  // y el tablero dormiría un día entero por una espera de quince minutos.
  assert.equal(quota.parseResetTime(notice('resets 4:30pm (UTC)'), utc(16, 45)), null);
});

test('la misma frase leída a las 15:45 sí da las 16:30 UTC', () => {
  assert.equal(quota.parseResetTime(notice('resets 4:30pm (UTC)'), utc(15, 45)), utc(16, 30));
});

test('el reloj de 24 h y una zona con nombre largo se leen igual', () => {
  assert.equal(quota.parseResetTime(notice('resets at 16:30 (UTC)'), utc(15, 45)), utc(16, 30));
  const madrid = quota.parseResetTime(notice('resets at 18:30 (Europe/Madrid)'), utc(15, 45));
  assert.ok(madrid > utc(15, 45) && madrid <= utc(15, 45) + 6 * 3600_000, 'dentro del tope');
});

test('«in 42 minutes» se toma tal cual, y «in 2 hours» también', () => {
  assert.equal(quota.parseResetTime(notice('resets in 42 minutes'), utc(16, 45)), utc(16, 45) + 42 * 60_000);
  assert.equal(quota.parseResetTime(notice('resets in 2 hours'), utc(16, 45)), utc(16, 45) + 2 * 3600_000);
});

test('sin zona se lee en la hora de la máquina, y sigue dentro del tope', () => {
  const now = utc(12, 0);
  const local = new Date(now);
  const hour = (local.getHours() + 1) % 24;
  const read = quota.parseResetTime(notice(`resets at ${hour}:15`), now);
  assert.ok(read !== null, 'una hora de dentro de una hora se lee');
  assert.equal(new Date(read).getHours(), hour);
  assert.ok(read - now > 0 && read - now <= quota.MAX_RECONSTRUCTED_MS);
});

test('lo que no se puede leer no se inventa', () => {
  assert.equal(quota.parseResetTime("You've hit your usage limit", utc(16, 45)), null);
  assert.equal(quota.parseResetTime('', utc(16, 45)), null);
  assert.equal(quota.parseResetTime(null, utc(16, 45)), null);
  assert.equal(quota.parseResetTime(notice('resets at 99:99'), utc(16, 45)), null);
});

test('la escalera ciega sube 20/40/80/160/300 y se queda arriba', () => {
  const now = utc(10, 0);
  const minutes = [1, 2, 3, 4, 5, 6, 40].map((n) => (quota.blindUntil(n, now) - now) / 60_000);
  assert.deepEqual(minutes, [20, 40, 80, 160, 300, 300, 300]);
  assert.deepEqual(quota.BLIND_LADDER_MINUTES, [20, 40, 80, 160, 300]);
});

// ---------------------------------------------------------------------------
// La detección, en orden de prioridad

const rateEvent = (info) => ({ type: 'rate_limit_event', rate_limit_info: info });
const assistant = (over = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }] }, ...over });

test('la vía buena es el evento estructural: trae la hora exacta y el tipo', () => {
  const at = utc(20, 0);
  const hit = quota.detectRateLimit(rateEvent({ status: 'rejected', resetsAt: at, rateLimitType: 'five_hour' }));
  assert.equal(hit.status, 'rejected');
  assert.equal(hit.resetsAt, at);
  assert.equal(hit.rateLimitType, 'five_hour');
  assert.equal(hit.via, 'sdk');
});

test('un resetsAt en segundos se normaliza a milisegundos', () => {
  const at = utc(20, 0);
  const hit = quota.detectRateLimit(rateEvent({ status: 'rejected', resetsAt: Math.floor(at / 1000) }));
  assert.equal(hit.resetsAt, at);
});

test('`status: allowed` no retiene nada: es lo contrario, una señal de vida', () => {
  const hit = quota.detectRateLimit(rateEvent({ status: 'allowed', utilization: 12 }));
  assert.equal(hit.status, 'allowed');
  assert.equal(quota.quotaHoldsNewWork(), false);
});

test('de los códigos de error del asistente solo `rate_limit` retiene', () => {
  assert.equal(quota.detectRateLimit(assistant({ error: 'rate_limit' })).status, 'rejected');
  // `overloaded` es pasajero: esperar cinco horas por él sería absurdo.
  assert.equal(quota.detectRateLimit(assistant({ error: 'overloaded' })), null);
  // `billing_error` es permanente: esperar por él no acaba nunca.
  assert.equal(quota.detectRateLimit(assistant({ error: 'billing_error' })), null);
  assert.equal(quota.detectRateLimit(assistant({ error: 'server_error' })), null);
});

test('TODOS los prefijos del SDK se reconocen, uno por uno', () => {
  assert.ok(PREFIXES.length >= 10, 'el SDK sigue exportando la lista');
  for (const prefix of PREFIXES) {
    const text = `${prefix} limit · resets 4:30pm (UTC)`;
    assert.ok(quota.looksLikeUsageLimit(text), `no se reconoce: ${prefix}`);
    const hit = quota.detectRateLimit(assistant({ message: { content: [{ type: 'text', text }] } }));
    assert.equal(hit?.status, 'rejected', `no se detecta por texto: ${prefix}`);
    assert.equal(hit.via, 'text');
    assert.equal(hit.text, text, 'el texto viaja para sacarle la hora');
  }
});

test('un texto normal no es un aviso de límite, aunque hable de límites', () => {
  assert.equal(quota.looksLikeUsageLimit('El límite de 25 minutos del QA se agotó'), false);
  assert.equal(quota.looksLikeUsageLimit("la nota decía que You've hit your limit, pero era de ayer"), false,
    'solo cuenta al principio de una línea');
  assert.equal(quota.detectRateLimit(assistant()), null);
});

test('el resultado de una sesión también se mira: ahí es donde acabó el aviso', () => {
  const hit = quota.detectRateLimit({ type: 'result', subtype: 'success', result: "You've reached your limit · resets in 30 minutes" });
  assert.equal(hit.status, 'rejected');
  assert.equal(hit.via, 'text');
});

// ---------------------------------------------------------------------------
// El aviso que no retiene pero siembra la hora

test('`allowed_warning` no abre retención, pero siembra la hora del rechazo siguiente', () => {
  quota.resetQuotaForTests();
  const at = Date.now() + 90 * 60_000;
  const warn = quota.detectRateLimit(rateEvent({ status: 'allowed_warning', resetsAt: at, utilization: 92, rateLimitType: 'five_hour' }));
  assert.equal(warn.status, 'warning');
  quota.noteQuotaWarning(warn);
  assert.equal(quota.quotaHoldsNewWork(), false, 'un aviso no para el tablero');
  assert.equal(quota.quotaState().state, 'released');
  assert.equal(quota.quotaState().warning.utilization, 92);

  // Y ahora el rechazo, sin hora ninguna: cae en la sembrada, no en la escalera.
  const hold = quota.noteQuotaHit({ status: 'rejected', via: 'error' });
  assert.equal(hold.until, at);
  assert.equal(hold.certainty, 'sdk');
  assert.equal(quota.quotaHoldsNewWork(), true);
  quota.resetQuotaForTests();
});

test('sin nada legible el rechazo cae en el primer peldaño de la escalera', () => {
  quota.resetQuotaForTests();
  const before = Date.now();
  const hold = quota.noteQuotaHit({ status: 'rejected', via: 'error', text: 'sin hora' });
  assert.equal(hold.certainty, 'blind');
  assert.equal(hold.attempt, 1);
  const minutes = (hold.until - before) / 60_000;
  assert.ok(minutes >= 19.9 && minutes <= 20.1, `escalón 1 = 20 min, no ${minutes}`);
  quota.resetQuotaForTests();
});

test('un rechazo con la hora en el texto la usa, con certeza «clock»', () => {
  quota.resetQuotaForTests();
  const hold = quota.noteQuotaHit({ status: 'rejected', via: 'text', text: notice('resets in 42 minutes') });
  assert.equal(hold.certainty, 'clock');
  const minutes = (hold.until - Date.now()) / 60_000;
  assert.ok(minutes > 41 && minutes <= 42.1);
  quota.resetQuotaForTests();
});

test('un segundo golpe durante la retención no abre otra, pero mejora la hora', () => {
  quota.resetQuotaForTests();
  const first = quota.noteQuotaHit({ status: 'rejected', via: 'error' });
  assert.equal(first.certainty, 'blind');
  const at = Date.now() + 3 * 3600_000;
  const second = quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: at, rateLimitType: 'five_hour' });
  assert.equal(second.id, first.id, 'la misma retención');
  assert.equal(second.attempt, 1, 'no es un peldaño nuevo: la ventana no llegó a reabrir');
  assert.equal(second.until, at);
  assert.equal(second.certainty, 'sdk');
  quota.resetQuotaForTests();
});

// ---------------------------------------------------------------------------
// Un límite semanal no se mide con la escalera de cinco horas

test('la escalera de un límite de siete días empieza en horas, no en minutos', () => {
  const now = utc(10, 0);
  const weekly = [1, 2, 3, 4, 9].map((n) => (quota.blindUntil(n, now, 'seven_day') - now) / 60_000);
  assert.deepEqual(weekly, [240, 480, 960, 1440, 1440]);
  assert.deepEqual(quota.BLIND_LADDER_WEEKLY_MINUTES, [240, 480, 960, 1440]);
  assert.equal(quota.isWeeklyLimit('seven_day_opus'), true);
  assert.equal(quota.isWeeklyLimit('five_hour'), false);
  // Y el de cinco horas sigue donde estaba.
  assert.equal((quota.blindUntil(1, now, 'five_hour') - now) / 60_000, 20);
});

test('un rechazo semanal sin hora no se cree un reloj de 15 minutos', () => {
  quota.resetQuotaForTests();
  // Veinte minutos dentro de una ventana de una semana son ~34 canarias
  // quemadas: una hora leída del texto pertenece al límite de cinco horas.
  const hold = quota.noteQuotaHit({
    status: 'rejected', via: 'text', rateLimitType: 'seven_day',
    text: notice('resets in 15 minutes'),
  });
  assert.equal(hold.certainty, 'blind');
  assert.equal((hold.until - Date.now()) / 3600_000 > 3.9, true, 'arranca en horas');
  quota.resetQuotaForTests();
});

test('`allowed` es una señal de vida: el evento estructural también lo dice', () => {
  const hit = quota.detectRateLimit(rateEvent({ status: 'allowed', utilization: 3 }));
  assert.equal(hit.status, 'allowed', 'la cuenta diciendo que la ventana está abierta');
});
