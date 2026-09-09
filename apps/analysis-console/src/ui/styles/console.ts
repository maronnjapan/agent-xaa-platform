/**
 * The stylesheet, as a module rather than a file on disk.
 *
 * `pnpm deploy` copies a package's compiled output, not its sources, so a `.css`
 * beside the components would be absent from the image and the page would arrive
 * unstyled in production and styled everywhere else. The Automation App solves this
 * with a bundler; this app has none and needs none, so the bytes live here and the
 * route below serves them.
 */
export const CONSOLE_CSS = `/*
 * The console's whole stylesheet, and it is small on purpose.
 *
 * This screen is a document: text, a card per agent, and one list per card. There is
 * nothing to press, so there is nothing that has to look pressable. The colours here
 * mean what they mean on the Automation App's timeline, so somebody reading both does
 * not have to learn two palettes.
 */
:root {
  --ink: #1b1b1f;
  --muted: #5b5b66;
  --edge: #d5d5dd;
  --ground: #f6f6f8;
  --accent: #1a4f9c;
}

body {
  margin: 0;
  color: var(--ink);
  background: var(--ground);
  font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif;
  line-height: 1.7;
}

.app-nav {
  display: flex;
  gap: 1.5rem;
  padding: 0.75rem 1.5rem;
  background: #fff;
  border-bottom: 1px solid var(--edge);
}

.app-nav a { color: var(--accent); }

main {
  max-width: 52rem;
  margin: 0 auto;
  padding: 1.5rem;
}

h1 { font-size: 1.5rem; }
h2 { font-size: 1.15rem; word-break: break-all; }

.lead { color: var(--muted); }

.card {
  margin: 1.5rem 0;
  padding: 1rem 1.25rem;
  background: #fff;
  border: 1px solid var(--edge);
  border-radius: 8px;
}

.agent-state { margin: 0 0 0.5rem; color: var(--muted); font-size: 0.85rem; }

/*
 * The analyser's judgements.
 *
 * One list per agent, one card per finding, and a left edge whose weight rises with the
 * risk level the detector assigned. The level is also written in words in the card's
 * head, so nothing here is the only way to tell two findings apart — the edge is there
 * so a person scrolling several agents can find the one that matters without reading
 * every card. The colours mean the same things they mean in emphasis.css.
 */
.console .note { color: var(--muted); font-size: 0.85rem; }

.findings {
  margin: 0;
  padding: 0;
  list-style: none;
}

.finding {
  margin: 0.75rem 0 0;
  padding: 0.6rem 0.9rem;
  border: 1px solid var(--edge);
  border-left: 4px solid #b6c2cf;
  border-radius: 6px;
  background: #fbfcfe;
}

.finding[data-risk-level="MEDIUM"] { border-left-color: #d8a94f; }
.finding[data-risk-level="HIGH"] { border-left-color: #c2792c; }
.finding[data-risk-level="CRITICAL"] { border-left-color: #b3402f; }

.finding-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.6rem;
  margin: 0 0 0.4rem;
}

.finding-level { font-weight: 700; }
.finding-at { color: var(--muted); font-size: 0.85rem; margin-left: auto; }
.finding-agent { margin: 0 0 0.5rem; font-size: 0.85rem; }

.finding-facts,
.finding-analysis,
.finding-outcome {
  margin: 0.4rem 0 0;
  font-size: 0.88rem;
}

.finding-facts dt,
.finding-analysis dt,
.finding-outcome dt {
  color: var(--muted);
  font-weight: 700;
}

.finding-facts dd,
.finding-analysis dd,
.finding-outcome dd {
  margin: 0 0 0.3rem;
  line-height: 1.6;
}

/* The model's four aspects are the reading matter; the facts around them are reference. */
.finding-analysis {
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  background: #fff;
}

.finding-note { margin: 0.4rem 0 0; color: var(--muted); font-size: 0.88rem; }

/*
 * The mechanical record sits below the judgements and folded shut.
 *
 * It is reference, not reading matter: a person opens it to ask whether their logs are
 * being read at all, and having asked once does not want the answer in the way of the
 * findings every time afterwards. Folded is the difference between available and loud.
 */
.inspections {
  margin: 0.8rem 0 0;
  padding-top: 0.6rem;
  border-top: 1px solid var(--edge);
  font-size: 0.88rem;
}

.inspections summary { color: var(--muted); cursor: pointer; }
.inspections ol { margin: 0.5rem 0 0; padding: 0; list-style: none; }

.inspection {
  margin: 0 0 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  background: #fff;
}

.inspection-facts { margin: 0; }
.inspection-facts dt { color: var(--muted); font-weight: 700; }
.inspection-facts dd { margin: 0 0 0.3rem; line-height: 1.6; }

/* A pass that could not run is the one line here that must not read as reassurance. */
.inspection-skipped { margin: 0.3rem 0 0; color: #8a5a1f; }
`;
