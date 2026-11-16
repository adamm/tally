// Tally's tracker. A site loads it with
//   <script defer src="https://tally.example.com/tally.js" data-site="bsh"
//           data-before-send="myHook"></script>
// and it reports each page view to Tally (/hit on the same server as this script). It sets no
// cookies and stores nothing in the browser.
//
// - Single-page apps: a new address (pushState, replaceState, Back and Forward) is a new page view.
//   Only the path and query count; a change of #hash alone isn't a new page.
// - Each view waits up to a second for the page's title (apps often set it once their data
//   loads), and is sent sooner when the visitor moves on or leaves.
// - Only the first view carries the address the visitor came from (document.referrer).
// - data-before-send names a function on window, called as hook(type, payload) before each hit
//   ('view' or 'event'). It returns the payload, changed if it likes (for example, with private
//   values removed from payload.url and payload.referrer), or null to send nothing.
// - window.tally.track(name, data) reports an event, like "listing-posted" with { type: "fixed" }.
(function () {
  var script = document.currentScript || document.querySelector('script[data-site][src*="tally.js"]');
  if (!script || !window.fetch) return;
  var site = script.getAttribute('data-site');
  var hookName = script.getAttribute('data-before-send');
  var endpoint = new URL('/hit', script.src).toString();
  var WAIT_MS = 1000;

  function send(type, extra, url) {
    var payload = {
      site: site,
      type: type,
      url: url || location.href,
      title: document.title,
      screen: screen.width + 'x' + screen.height,
    };
    for (var k in extra) payload[k] = extra[k];
    var hook = hookName && window[hookName];
    if (typeof hook === 'function') {
      try { payload = hook(type, payload); } catch (e) { payload = null; }
      if (!payload) return;
    }
    try {
      fetch(endpoint, {
        method: 'POST',
        // text/plain, so the browser sends it at once without asking the server first.
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: 'omit',
      }).catch(function () {});
    } catch (e) { /* statistics never break the page */ }
  }

  // The view waiting for its title: { timer, url }. The address is kept from when the page
  // opened, since by the time a waiting view is sent the browser may be on the next page.
  var pending = null;
  var lastAddress = null;
  var referrer = document.referrer;

  function flush() {
    if (!pending) return;
    var view = pending;
    clearTimeout(view.timer);
    pending = null;
    send('view', { referrer: referrer || null }, view.url);
    referrer = null;
  }

  function changed() {
    var address = location.pathname + location.search;
    if (address === lastAddress) return;
    lastAddress = address;
    flush();
    pending = { timer: setTimeout(flush, WAIT_MS), url: location.href };
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var result = original.apply(this, arguments);
      changed();
      return result;
    };
  });
  addEventListener('popstate', changed);
  addEventListener('pagehide', flush);

  window.tally = {
    track: function (name, data) { send('event', { name: name, data: data || null }); },
  };

  changed();
})();
