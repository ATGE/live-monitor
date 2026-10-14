// Un directorio de datos propio, puesto ANTES de que nadie cargue `config.js`.
//
// Se importa por su efecto, y tiene que ir en la PRIMERA línea de `import` del
// archivo de prueba: los módulos se evalúan en el orden en que se importan, así
// que lo que esté encima corre antes que cualquier `../src/…`. Un `process.env`
// escrito en el cuerpo del archivo llegaría tarde — las sentencias corren
// después de todos los imports.
//
// Es para los archivos cuyos imports de `../src/` son estáticos y llegan, aunque
// sea de lejos, a un módulo que escribe en el directorio de datos: `store.js`,
// `quota.js`, `upgrade.js`, `settings.js`. Sin esto, una prueba escribiría en el
// tablero vivo — y dos procesos a la vez se pisan el archivo a medio escribir.
import { tempDir } from './teardown.mjs';

// `??=`: un archivo que ya eligió el suyo se queda con el suyo, y un directorio
// heredado del padre no es nuestro: solo se registra (y se borra al salir) el que
// este proceso creó.
process.env.HFSMON_DATA_DIR ??= tempDir('hfsmon-test-');

export const DATA_DIR = process.env.HFSMON_DATA_DIR;
