export const name = "95-release-layout";

export async function run(t) {
  for (const route of ["chat", "arena", "tests", "models"]) {
    await t.open(route, "?sim=1");
    await t.waitFor(`!!document.querySelector('#view')?.firstElementChild`, 20000);
    await t.setViewport(1440, 900);
    t.assert(await t.eval(`document.documentElement.scrollWidth <= innerWidth`), `${route} overflows at 1440`);
    await t.screenshot(`release-${route}`);
    await t.setViewport(1024, 900);
    t.assert(await t.eval(`document.documentElement.scrollWidth <= innerWidth`), `${route} overflows at 1024`);
  }
}
