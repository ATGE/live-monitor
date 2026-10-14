// Shared vocabulary and glossary: every area reuses these words instead of
// spelling its own. Spanish is the source language; en, fr and de must keep
// exactly these keys and `{holes}`. French and German address the user informally.
export default {
  cancel: 'Cancelar',
  close: 'Cerrar',
  accept: 'Aceptar',
  save: 'Guardar',
  delete: 'Borrar',
  retry: 'Reintentar',
  loading: 'Cargando…',
  yes: 'Sí',
  no: 'No',
  none: 'Ninguno',
  back: 'Volver',
  task: { one: '{n} tarea', other: '{n} tareas' },
  // A language names itself the same way in every catalog.
  languageNames: { es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch' },
};
