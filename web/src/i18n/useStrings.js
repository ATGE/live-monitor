import { useSyncExternalStore } from 'react';
import { locale, onLocaleChange, strings } from './index.js';

/**
 * The board's words in the language now in use; the component re-renders when
 * it changes. The snapshot is the catalog object, stable per language.
 */
export const useStrings = () => useSyncExternalStore(onLocaleChange, strings, strings);

/** The language code itself, for the control that shows which one is on. */
export const useLocale = () => useSyncExternalStore(onLocaleChange, locale, locale);
