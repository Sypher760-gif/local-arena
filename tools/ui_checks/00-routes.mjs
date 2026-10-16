// Every screen opens with the top bar: four nav links, the current one marked. No page errors.
export const name = "00-routes";

export async function run(t) {
  for (const route of ["chat", "models", "arena", "tests"]) {
    await t.open(route);
    const links = await t.count("#topbar nav a");
    t.assert(links === 4, `${route}: top bar has ${links} nav links, want 4`);
    t.assert(
      await t.exists(`#topbar nav a[data-route="${route}"][aria-current="page"]`),
      `${route}: nav link for this screen is not marked current`,
    );
  }
}
