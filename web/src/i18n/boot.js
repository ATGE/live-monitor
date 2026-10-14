/**
 * Applies the saved language before the first paint. `main.jsx` imports this
 * first, ahead of the app, so the root is created with the right strings and
 * `<html lang>` already set. The read is synchronous (localStorage through
 * storage.js); an absent or unknown value falls back to Spanish.
 */
import { applyLocale, LOCALE_KEY } from './index.js';
import { read } from '../storage.js';

export const bootLocale = () => applyLocale(read(LOCALE_KEY, null));

bootLocale();
