/**
 * The pieces every Control Plane admin console is built from.
 *
 * The consoles live in the apps that own the data they edit — permissions in the
 * Authorization Platform, documents in the Document Resource API — because the app that
 * decides with a table is the app that edits it. What they share is not data but a shape:
 * the same shell, the same stylesheet, the same reading of a submitted form. Those three
 * things are here, so two consoles cannot drift into looking like two products.
 */
export type { Element } from './element.js';
export { AdminErrors, AdminShell, renderAdminPage, type AdminNavLink } from './shell.js';
export { ADMIN_CONSOLE_CSS, ADMIN_STYLESHEET_PATH } from './styles.js';
export { isChecked, readFormInput, wantsJson, type AdminInput } from './form-input.js';
