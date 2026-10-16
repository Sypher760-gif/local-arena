// Chat, Models, Arena and Tests show no horizontal overflow at 1280 and 1024 wide.
export const name = "70-narrow-layout";

const SCREENS = [
  { hash: "chat", ready: `document.querySelector('.chat-input')` },
  { hash: "models", ready: `document.querySelector('.live-model-row')` },
  { hash: "arena", ready: `document.querySelector('.arena-answers')` },
  { hash: "tests", ready: `document.querySelector('.tests-toolbar')` },
];
const WIDTHS = [1280, 1024];

const measure = `(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))()`;

export async function run(t) {
  for (const width of WIDTHS) {
    await t.setViewport(width);
    for (const screen of SCREENS) {
      await t.open(screen.hash);
      await t.waitFor(screen.ready, 8000);
      const m = await t.eval(measure);
      t.assert(m.iw === width, `${screen.hash} at ${width}px: viewport did not resize (innerWidth ${m.iw})`);
      t.assert(m.sw <= m.iw, `${screen.hash} at ${width}px: horizontal overflow (scrollWidth ${m.sw} > innerWidth ${m.iw})`);
    }
  }
}
