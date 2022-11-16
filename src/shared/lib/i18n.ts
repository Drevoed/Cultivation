import { useConfigurationManager } from 'entities/configuration/model';
import { createContext, createMemo, createSignal, useContext } from 'solid-js';
import { createStore } from 'solid-js/store';
import { invoke } from '@tauri-apps/api';

declare module 'shared/lib/tauri' {
  export interface InvokeMap {
    get_lang: {
      args: {
        lang: string;
      };
      return: Record<string, any>;
    };
  }
}

/**
 * Inlined @solid-primitives/i18n with a fix.
 */

/**
 * Safely access deep values in an object via a string path seperated by `.`
 *
 * @param obj {Record<string, any>} - The object to parse
 * @param path {string} - The path to search in the object
 * @param [defaultValue] {unknown} -  A default value if the path doesn't exist in the object
 *
 * @returns {any} - The value if found, the default provided value if set and not found, undefined otherwise
 *
 * @example
 *
 * ```js
 * const obj = { a: { b : { c: 'hello' } } };
 *
 * const value = deepReadObject(obj, 'a.b.c');
 * // => 'hello'
 * const notFound = deepReadObject(obj, 'a.b.d');
 * // => undefined
 * const notFound = deepReadObject(obj, 'a.b.d', 'not found');
 * // => 'not found'
 * ```
 */
const deepReadObject = <T = any>(
  obj: Record<string, unknown>,
  path: string,
  defaultValue?: unknown
): T => {
  const value = path
    .trim()
    .split('.')
    .reduce<any>((a, b) => (a ? a[b] : undefined), obj);
  return value !== undefined ? value : defaultValue;
};

/**
 * Provided a string template it will replace dynamics parts in place of variables.
 *
 * This util is largely inspired by [templite](https://github.com/lukeed/templite/blob/master/src/index.js)
 *
 * @param str {string} - The string you wish to use as template
 * @param params {Record<string, string>} - The params to inject into the template
 * @param [reg=/{{(.*?)}}/g] {RegExp} - The RegExp used to find and replace
 *
 * @returns {string} - The fully injected template
 *
 * @example
 * ```js
 * const txt = template('Hello {{ name }}', { name: 'Tom' });
 * // => 'Hello Tom'
 * ```
 */
const template = (
  str: string,
  params: Record<string, string>,
  reg = /{{(.*?)}}/g
): any => str.replace(reg, (_, key) => deepReadObject(params, key, ''));

/**
 * This creates a I18nContext. It's extracted into a function to be able to type the Context
 * before it's even initialized.
 *
 * @param [init={}] {Record<string, Record<string, any>>} - Initial dictionary of languages
 * @param [lang=navigator.language] {string} - The default language fallback to browser language if not set
 */
export const createI18nContext = (
  init: Record<string, Record<string, any>> = {},
  lang: string = navigator.language in init
    ? navigator.language
    : Object.keys(init)[0]
): [
  template: (
    key: string,
    params?: Record<string, string>,
    defaultValue?: string
  ) => any,
  actions: {
    add(lang: string, table: Record<string, any>): void;
    locale: (lang?: string) => string;
    dict: (lang: string) => Record<string, Record<string, any>>;
  }
] => {
  const [locale, setLocale] = createSignal(lang);
  const [dict, setDict] = createStore(init);
  /**
   * The main translation function of the library. Given a key, it will look into its
   * dictionaries to find the right translation for that key and fallback to the default
   * translation provided in last argument (if provided).
   *
   * You can additionally give as a second arguments dynamic parameters to inject into the
   * the translation.
   *
   * @param key {string} - The key to look up a translation for
   * @param [params] {Record<string, string>} - Parameters to pass into the translation template
   * @param [defaultValue] {string} - Default value if the translation isn't found
   *
   * @returns {string} - The translated string
   *
   * @example
   * ```tsx
   * const [t] = useI18n();
   *
   * const dict = { fr: { hello: 'Bonjour {{ name }} !' } }
   * locale('fr')
   * t('hello', { name: 'John' }, 'Hello, {{ name }}!');
   * // => 'Bonjour John !'
   * locale('unknown')
   * t('hello', { name: 'Joe' }, 'Hello, {{ name }}!');
   * // => 'Hello, Joe!'
   * ```
   */
  const translate = (
    key: string,
    params?: Record<string, string>,
    defaultValue?: string
  ): string => {
    const val = deepReadObject(dict[locale()], key, defaultValue || '');
    if (typeof val === 'function') return val(params);
    if (typeof val === 'string') return template(val, params || {});
    return val;
  };
  const actions = {
    /**
     * Add (or edit an existing) locale
     *
     * @param lang {string} - The locale to add or edit
     * @param table {Record<string, any>} - The dictionary
     *
     * @example
     * ```js
     * const [_, { add }] = useI18n();
     *
     * const addSwedish = () => add('sw', { hello: 'Hej {{ name }}' })
     * ```
     */
    add(lang: string, table: Record<string, any>) {
      setDict(lang, table);
    },
    /**
     * Switch to the language in the parameters.
     * Retrieve the current locale if no params
     *
     * @param [lang] {string} - The locale to switch to
     *
     * * @example
     * ```js
     * const [_, { locale }] = useI18n();
     *
     * locale()
     * // => 'fr'
     * locale('sw')
     * locale()
     * // => 'sw'
     *
     * ```
     */
    locale: (lang?: string) => (lang ? setLocale(lang) : locale()),
    /**
     * Retrieve the dictionary of a language
     *
     * @param lang {string} - The language to retrieve from
     */
    dict: (lang: string) => deepReadObject(dict, lang),
  };
  return [
    function t(key, params, defaultValue) {
      const manager = useConfigurationManager();
      const translated = createMemo(() => translate(key, params, defaultValue));

      console.log('translated', translated());

      if (translated() === '') fetchTranslation(key, actions.add, manager);

      return translated();
    },
    actions,
  ];
};

type I18nContextInterface = ReturnType<typeof createI18nContext>;

export const I18nContext = createContext<I18nContextInterface>(
  {} as I18nContextInterface
);
const useI18n = () => useContext(I18nContext);

let fetching = false;
async function fetchTranslation(
  key: string,
  add: (lang: string, table: Record<string, any>) => void,
  manager: ReturnType<typeof useConfigurationManager>
) {
  if (fetching) return;
  fetching = true;
  let language = manager.getConfigOption('language');

  // default path
  if (!language) {
    const defaultResp = await invoke('get_lang', { lang: 'en' });

    add('en', defaultResp);
  } else {
    const response = await invoke('get_lang', { lang: language });
    add(language, response);
  }
  fetching = false;
}

export function useEnrichedI18n() {
  return useI18n();
}
