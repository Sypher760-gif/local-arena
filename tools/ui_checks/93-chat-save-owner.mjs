export const name = "93-chat-save-owner";

export async function run(t) {
  await t.killEngine();
  await t.startEngine(["--wps", "30"]);
  await t.eval(`(async () => {
    for(const [id,title] of [['release-chat-a','Release chat A'],['release-chat-b','Release chat B']]) {
      await fetch('/api/store/chats/'+id, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        id,title,system:'',created:Date.now(),updated:Date.now(),messages:[{role:'user',text:'earlier question'}]
      })});
    }
    localStorage.setItem('bench.chat.last','release-chat-a');
    return true;
  })()`);
  try {
    await t.reload();
    await t.waitFor(`document.querySelector('.chat-title')?.textContent === 'Release chat A' || [...document.querySelectorAll('.chat-row-wrap')].some(n => n.dataset.id === 'release-chat-a')`, 20000);
    await t.click('.chat-row-wrap[data-id="release-chat-a"] .list-row');
    await t.type(".chat-input", "Save this reply to chat A");
    await t.click(".chat-composer-bar .btn-primary");
    await t.waitFor(`globalThis.benchEngine.streaming`, 20000);
    await t.click('.chat-row-wrap[data-id="release-chat-b"] .list-row');
    await t.waitFor(`!globalThis.benchEngine.streaming`, 20000);
    await t.waitFor(`(async () => (await (await fetch('/api/store/chats/release-chat-a')).json()).messages.some(m => m.role === 'model' && m.stats))()`, 20000);
    const a = await t.storeGet("chats", "release-chat-a");
    const b = await t.storeGet("chats", "release-chat-b");
    t.assert(a.messages.at(-1).role === "model" && a.messages.at(-1).text.length > 0, "completed reply was lost from its original chat");
    t.assert(b.messages.length === 1, "reply was saved into the viewed chat");
    await t.click(".chat-system-toggle");
    await t.type(".chat-system-text", "Saved without sending another message");
    await t.waitFor(`(async () => (await (await fetch('/api/store/chats/release-chat-b')).json()).system === 'Saved without sending another message')()`, 10000);
    await t.reload();
    await t.waitFor(`document.querySelector('.chat-system-text')?.value === 'Saved without sending another message'`, 20000);
    await t.click(".chat-msg-user .chat-action-delete");
    await t.click('.chat-row-wrap[data-id="release-chat-a"] .list-row');
    await t.waitFor(`(async () => (await (await fetch('/api/store/chats/release-chat-b')).json()).messages.length === 0)()`, 10000);
  } finally {
    await t.eval(`Promise.all(['release-chat-a','release-chat-b'].map(id => fetch('/api/store/chats/'+id,{method:'DELETE'}))).then(() => true)`);
  }
}
