/**
 * The consoles' stylesheet, as a module rather than a file on disk.
 *
 * `pnpm deploy` copies a package's compiled output, not its sources, so a `.css` beside
 * the components would be absent from the image and every console would arrive unstyled
 * in production and styled everywhere else. The Automation App solves this with a
 * bundler; the consoles have none and need none, so the bytes live here and each app
 * serves them from `ADMIN_STYLESHEET_PATH`.
 *
 * One stylesheet for every admin console on purpose. An administrator moves between the
 * permission screens and the document screens in one sitting, and two palettes would
 * make them look like two products with one login.
 */
export const ADMIN_CONSOLE_CSS = `/*
 * The admin consoles' whole stylesheet.
 *
 * These screens are forms and tables. Nothing animates, nothing floats, and the only
 * colour that carries meaning is the one on the destructive button — everything else is
 * ink on paper, because an administrator reading a permission table is reading, not
 * being guided.
 */
:root {
  color-scheme: light dark;
  --ink: #1b1b1f;
  --muted: #5b5b66;
  --edge: #d5d5dd;
  --ground: #f6f6f8;
  --paper: #ffffff;
  --accent: #1a4f9c;
  --danger: #a3261f;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8e8ee;
    --muted: #a2a2b0;
    --edge: #3a3a44;
    --ground: #16161a;
    --paper: #1e1e24;
    --accent: #7fb0f0;
    --danger: #f08a82;
  }
}

body {
  margin: 0 auto;
  max-width: 68rem;
  padding: 1.5rem;
  line-height: 1.7;
  color: var(--ink);
  background: var(--ground);
  font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif;
}

h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }

nav.admin-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  padding-bottom: 0.8rem;
  border-bottom: 1px solid var(--edge);
}

nav.admin-nav a { color: var(--accent); }

a { color: var(--accent); }

table {
  border-collapse: collapse;
  width: 100%;
  background: var(--paper);
}

th, td {
  border: 1px solid var(--edge);
  padding: 0.4rem 0.6rem;
  text-align: left;
  vertical-align: top;
}

th { background: color-mix(in srgb, var(--edge) 40%, transparent); }

code { font-family: ui-monospace, monospace; }

form.stack label { display: block; margin: 0.8rem 0; }

input[type=text], input[type=date], input[type=datetime-local], select, textarea {
  width: 100%;
  max-width: 34rem;
  padding: 0.3rem;
  font: inherit;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--edge);
  border-radius: 3px;
}

textarea { min-height: 8rem; font-family: ui-monospace, monospace; }

button {
  padding: 0.4rem 1rem;
  font: inherit;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--edge);
  border-radius: 3px;
  cursor: pointer;
}

button.destructive { color: var(--danger); border-color: var(--danger); }

form.inline { display: inline; }

.errors {
  border: 1px solid var(--danger);
  color: var(--danger);
  padding: 0.6rem 1rem;
  background: var(--paper);
}

.note { color: var(--muted); font-size: 0.9rem; }

.danger {
  margin-top: 2rem;
  border-top: 1px solid var(--edge);
  padding-top: 1rem;
}

.owner-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: baseline;
  margin: 1rem 0;
}

.owner-bar input[type=text] { max-width: 22rem; }
`;

/**
 * Where every console serves the stylesheet.
 *
 * It sits under `/admin` so it is behind the same guard as the screens: a path outside
 * it would be one route on these services reachable without an administrator's token,
 * and "it is only CSS" is the argument that ends with a second such route.
 */
export const ADMIN_STYLESHEET_PATH = '/admin/console.css';
