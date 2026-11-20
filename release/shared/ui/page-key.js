// The page key (shared/page-key.ts): kept in this origin's own storage, which a page at another
// port of this name cannot read (it can be sent this name's cookies), and sent with every
// request this page makes. Loaded first by each of desolate's pages, and by the page a sign-in
// answers with, which carries the key and where to go on to.
(() => {
  const NAME = "desolate-key";
  const given = document.querySelector('meta[name="desolate-key"]');
  if (given) {
    try {
      localStorage.setItem(NAME, given.content);
    } catch {
      // Storage refused (a browser set to keep none): the page will say to sign in again.
    }
    const next = document.querySelector('meta[name="desolate-next"]');
    location.replace(next ? next.content : "/");
    return;
  }
  let key = "";
  try {
    key = localStorage.getItem(NAME) || "";
  } catch {
    key = "";
  }
  window.desolateKey = Object.freeze({
    headers: Object.freeze({ "x-desolate-key": key }),
    query: `key=${encodeURIComponent(key)}`,
  });
})();
