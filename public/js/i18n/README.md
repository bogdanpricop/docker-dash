# Adding a New Language

## Quick Start

1. Copy `TEMPLATE.js` to `{code}.js` (e.g., `de.js` for German, `fr.js` for French)
2. Edit the `register()` call at the top:
   ```javascript
   i18n.register('de', 'DE', 'Deutsch', {
   ```
3. Translate all string values (keep the keys in English)
4. Add a `<script>` tag in `index.html`:
   ```html
   <script src="/js/i18n/de.js?v=5.5"></script>
   ```
5. That's it! The language appears automatically in the language selector.

## Rules

- **Don't modify `en.js`** unless you're adding new keys for a new feature
- `en.js` is the **fallback** — any missing key in your language will show the English text
- Keep `{{variable}}` placeholders as-is (they're replaced at runtime)
- Some values contain HTML (e.g., `<strong>`, `<br>`) — keep the HTML tags
- Test your translation by switching to it in the app (click the language button in the sidebar footer)

## Language Codes

Use [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) two-letter codes:

| Code | Language | Native Name |
|------|----------|-------------|
| en | English | English |
| ro | Romanian | Română |
| de | German | Deutsch |
| fr | French | Français |
| es | Spanish | Español |
| it | Italian | Italiano |
| pt | Portuguese | Português |
| nl | Dutch | Nederlands |
| pl | Polish | Polski |
| ja | Japanese | 日本語 |
| zh | Chinese | 中文 |
| ko | Korean | 한국어 |

## File Structure

```
i18n/
  en.js        ← English (base/fallback, ~900 keys)
  ro.js        ← Romanian
  TEMPLATE.js  ← Copy this to start a new language
  README.md    ← This file
```

## Partial Translations

You don't need to translate every key. Missing keys automatically fall back to English.
Start with the most visible sections: `common`, `nav`, `login`, `pages.dashboard`, `pages.containers`.
