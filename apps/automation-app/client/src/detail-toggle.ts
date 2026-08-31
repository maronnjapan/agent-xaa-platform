/**
 * `<details>` already opens and closes itself; this only makes the list rows and the
 * replay results share the same element instances, so a detail opened in one place is
 * the same one in the other. Nothing is written to storage — the open state is a
 * moment, not a preference.
 */
export function wireDetailToggles(root: ParentNode): void {
  root.querySelectorAll('[data-detail="true"]').forEach((element) => {
    element.addEventListener('toggle', () => { /* no persistence, by design */ });
  });
}
