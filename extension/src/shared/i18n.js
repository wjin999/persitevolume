export function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// Fills data-i18n (text) and data-i18n-<attribute> placeholders.
export function localize(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['title', 'placeholder', 'aria-label']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
