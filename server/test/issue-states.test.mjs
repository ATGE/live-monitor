import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_STATE_BATCH, issueStatesQueries, parseIssueStates, repo } from '../src/github.js';

// El tablero se enteraba de que un issue estaba cerrado sólo si aparecía en
// `gh issue list --state closed --limit 12`, y ese listado ordena por NÚMERO
// descendente, no por fecha de cierre: #1126 y #937 fueron los dos últimos
// issues asignados que se cerraron (2026-09-26) y están en las posiciones 17 y
// 30, así que nunca entraban en la ventana y su `issueClosed` se quedaba en
// `false` para siempre. `issueStatesQueries` + `parseIssueStates` son la puerta
// que pregunta por número, y son puras: aquí no hay ningún doble de `run`, y no
// se invoca `issueStates` (la única de las tres que lanza `gh`).

/** El cuerpo verificado a mano contra el repositorio real: un issue de verdad,
 *  un alias que no resuelve, y `errors` a nivel superior con exit = 1. */
const PARTIAL_BODY = JSON.stringify({
  data: {
    repository: {
      i937: {
        number: 937,
        state: 'CLOSED',
        title: 'fix: the worktree keeps a file named nul',
        url: 'https://github.com/HeliosSoftware/hfs/issues/937',
        labels: { nodes: [{ name: 'bug' }, { name: 'windows' }] },
      },
      i99999: null,
    },
  },
  errors: [{ type: 'NOT_FOUND', path: ['repository', 'i99999'], message: 'Could not resolve to an Issue with the number 99999.' }],
});

const body = (repository) => JSON.stringify({ data: { repository } });

const row = (over) => ({
  number: 1, state: 'OPEN', title: 't', url: 'u', labels: { nodes: [] }, ...over,
});

test('el constructor pide exactamente los números dados, con alias i<n>, sin repetir y en orden', () => {
  const [owner, name] = repo('hfs').split('/');
  const [query, ...rest] = issueStatesQueries([1126, 937, 1126], 'hfs');

  assert.equal(rest.length, 0, 'tres números (uno repetido) caben de sobra en un solo lote, así que sólo debe salir una consulta');
  assert.equal(
    query.includes(`repository(owner: "${owner}", name: "${name}")`), true,
    'la consulta tiene que ir contra el repositorio que resolvió repo(), y no contra uno escrito a mano',
  );
  assert.deepEqual(
    [...query.matchAll(/(\w+): issue\(number: (\d+)\)/g)].map((m) => [m[1], Number(m[2])]),
    [['i937', 937], ['i1126', 1126]],
    'cada número aparece una sola vez, ordenado, y su alias es la i más el número: el duplicado no puede pedirse dos veces en la misma selección',
  );
  assert.equal(
    /[{\s]\d/.test(query.replace(/number: \d+/g, 'number: N').replace(/first: \d+/g, 'first: N')), false,
    'un alias que empiece por dígito es un error de sintaxis de GraphQL: por eso el alias es i<n> y nunca el número desnudo',
  );
});

test('un número que no es entero positivo se descarta: vacío, con letras, negativo o con decimales', () => {
  for (const bad of ['', '12a', -1, 1.5]) {
    assert.deepEqual(
      issueStatesQueries([bad], 'hfs'), [],
      `${JSON.stringify(bad)} no es el número de ningún issue y no debe llegar al texto de la consulta: `
      + "Number('') es 0 y Number('12a') es NaN, así que sin la validación se preguntaría por el issue #0 o se mandaría basura",
    );
  }
  const [query] = issueStatesQueries(['', '12a', -1, 1.5, '937'], 'hfs');
  assert.deepEqual(
    [...query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1])), [937],
    'la basura mezclada con un número válido se cae sola y deja pasar sólo al válido, en vez de invalidar la consulta entera',
  );
});

test('los números se reparten en lotes de ISSUE_STATE_BATCH y cada uno aparece exactamente una vez', () => {
  const numbers = Array.from({ length: 120 }, (_, i) => i + 1);
  const queries = issueStatesQueries(numbers, 'hfs');

  assert.equal(ISSUE_STATE_BATCH, 50, 'el tamaño de lote es parte del contrato: si cambia, cambia el número de procesos gh por ciclo');
  assert.equal(queries.length, 3, '120 números en lotes de 50 son tres consultas: 50, 50 y 20');

  const asked = queries.flatMap((q) => [...q.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1])));
  assert.equal(asked.length, 120, 'ningún número puede perderse ni duplicarse al trocear: el reparto es la única garantía de que se pregunta por todos');
  assert.deepEqual([...new Set(asked)].sort((a, b) => a - b), numbers, 'el conjunto preguntado es exactamente el conjunto pedido');
});

test('un alias nulo no borra la respuesta: el cuerpo parcial real devuelve un Map de una entrada', () => {
  const states = parseIssueStates(PARTIAL_BODY);

  assert.notEqual(states, null, 'hay data.repository utilizable, así que el cuerpo es una respuesta de verdad aunque gh haya salido con 1');
  assert.equal(states.size, 1, 'el issue borrado se queda fuera del Map y el real sigue dentro: un solo alias que no resuelve no puede anular todo el barrido');
  assert.equal(states.get(937).closed, true, 'lo que GitHub contestó de #937 tiene que llegar intacto pese al error del otro alias');
  assert.equal(states.has(99999), false, 'un alias nulo está AUSENTE del Map, nunca apuntado como abierto: eso reabriría una tarea que GitHub no conoce');
});

test('labels.nodes[].name se aplana a string[] y la fila tiene la misma forma que una de issueList', () => {
  const states = parseIssueStates(PARTIAL_BODY);
  const got = states.get(937);

  assert.deepEqual(
    got.labels, ['bug', 'windows'],
    'noteIssue copia issue.labels tal cual sobre la tarea, así que las etiquetas tienen que ser cadenas planas y no el { nodes: [{ name }] } de GraphQL',
  );
  assert.deepEqual(
    Object.keys(got).sort(), ['assignees', 'closed', 'labels', 'number', 'title', 'url'],
    'issueList devuelve {number, title, url, closed, labels, assignees}: estas filas van a los mismos consumidores, así que no pueden traer ni una clave menos ni el `state` crudo de más',
  );
  assert.deepEqual(
    parseIssueStates(body({ i1: row({ labels: { nodes: [] } }) })).get(1).labels, [],
    'un issue sin etiquetas da un array vacío, no undefined: quien lo copie sobre la tarea no debe borrarle el campo',
  );
});

test('assignees.nodes[].login se aplana a string[]: cero, uno y varios asignados', () => {
  const login = (l) => ({ login: l });
  const one = parseIssueStates(body({ i1: row({ number: 1, assignees: { nodes: [login('eterceros')] } }) })).get(1);
  assert.deepEqual(one.assignees, ['eterceros'], 'un asignado es una lista de un login');
  const many = parseIssueStates(body({ i2: row({ number: 2, assignees: { nodes: [login('a'), null, login('b')] } }) })).get(2);
  assert.deepEqual(many.assignees, ['a', 'b'], 'varios asignados conservan el orden y un nodo nulo se descarta');
  const none = parseIssueStates(body({ i3: row({ number: 3, assignees: { nodes: [] } }) })).get(3);
  assert.deepEqual(none.assignees, [], 'sin asignar es una lista vacía, no undefined');
  const missing = parseIssueStates(body({ i4: row({ number: 4 }) })).get(4);
  assert.deepEqual(missing.assignees, [], 'una respuesta sin el campo da lista vacía');
});

test('la consulta pide los asignados de cada alias', () => {
  const [query] = issueStatesQueries([1, 2], 'hfs');
  assert.equal(query.split('assignees(first: 20) { nodes { login } }').length - 1, 2, 'cada alias lleva su selección de assignees');
});

test('CLOSED se traduce a closed: true y OPEN a closed: false', () => {
  assert.equal(
    parseIssueStates(body({ i1: row({ number: 1, state: 'CLOSED' }) })).get(1).closed, true,
    'el único estado que cierra una tarea es CLOSED, y es el que el tablero venía sin poder ver',
  );
  assert.equal(
    parseIssueStates(body({ i2: row({ number: 2, state: 'OPEN' }) })).get(2).closed, false,
    'OPEN se registra como abierto explícitamente: así el ciclo siguiente ve que el issue volvió a abrirse',
  );
});

test('sin data.repository devuelve null, y con data.repository pero todos los alias nulos devuelve un Map vacío', () => {
  for (const nothing of ['', 'no es json', '{}', JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), JSON.stringify({ data: { repository: null } })]) {
    assert.equal(
      parseIssueStates(nothing), null,
      `${JSON.stringify(nothing).slice(0, 40)} no es una respuesta: hay que devolver null para que quien llama lance en vez de creerse que ningún issue está cerrado`,
    );
  }
  const empty = parseIssueStates(body({ i1: null, i2: null }));
  assert.notEqual(empty, null, 'GitHub sí contestó —con data.repository— aunque ninguno de los alias resolviera: eso no es un fallo de gh');
  assert.equal(empty.size, 0, 'un Map vacío significa «de estos issues, ninguno se supo»; null significa «GitHub no contestó», y confundirlos es el bug original con pasos extra');
});
