'use strict';

// Free My TV's Home watcher on Samsung TVs, in the package only when built with tizen/build.py --home-watcher.
// The TV starts it at power-on: it opens Free My TV then, and again when Samsung Home covers it. A hidden web app is
// frozen, so the watching happens here, over the TV's own API (127.0.0.1:8001), which says whether each app is
// running and on screen. How it reads that API and when it stands aside follow AeroTizen's watcher
// (github.com/helalaou/AeroTizen, MIT).
// The home screen tells it, on 127.0.0.1:47791, what it opens (/watch), the TV's apps (/apps), that it's on screen
// again (/home), and that the person asked for Samsung Home (/leave).
var http = require('http');
var url = require('url');

var SELF = 'FreeMyTVio.FreeMyTV';
var PORT = 47791;
var VIEWER = 'org.tizen.tv-viewer';   // Live TV and the inputs, which the TV's app list leaves out
var TICK = 300;
var HIDDEN_GRACE = 250;    // Samsung Home shows almost at once
var APP_GRACE = 2500;      // an app just opened may take this long to cover the home screen
var COVER_GRACE = 10000;   // past this, an app the home screen opened isn't on its way any more
var STOP_GRACE = 1500;     // a watched app stopped this long has closed
var SCAN = 5000;           // every app is checked this often
var BOOT_DELAY = 3000;
var BOOT_UPTIME = 120;     // seconds: a start later than this is the service restarting, not the TV
var MIN_GAP = 2000;        // never two launches closer than this
var CATALOG_REFRESH = 600000;   // an app installed or updated meanwhile joins the catalog within this long

var state = {
  watched: null, seen: false, ran: false, watchAt: 0, hiddenSince: 0, watchedHiddenSince: 0, stoppedSince: 0,
  selfVisible: null, apps: [VIEWER], running: {}, scanAt: 0, leaving: false, frame: null,
  lastLaunch: 0, launches: 0, last: ''
};
var server = null, interval = null, retry = null, bootTimer = null, catalogTimer = null, busy = false, stopped = false, epoch = 0;

function get(path, done) {
  var settled = false, req = null;
  var timer = setTimeout(function () { finish(null); if (req) req.destroy(); }, 1500);
  function finish(value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(value);
  }
  try {
    req = http.get({host: '127.0.0.1', port: 8001, path: path}, function (res) {
      var body = '';
      res.on('data', function (chunk) {
        body += chunk;
        if (body.length > 65536) { finish(null); req.destroy(); }
      });
      res.on('error', function () { finish(null); });
      res.on('end', function () {
        if (res.statusCode !== 200) { finish(null); return; }
        try { finish(JSON.parse(body)); } catch (e) { finish(null); }
      });
    });
    req.on('error', function () { finish(null); });
  } catch (e) {
    finish(null);
  }
}

/**
 * The TV's status API (127.0.0.1:8001) doesn't know a store app's Tizen id (org.tizen.netflix-app): it only answers
 * to the store's own numeric id (3201907018807), which Free My TV never sees. Both ids are in tizen.application's
 * own app list, though: the numeric one is the last part of each app's iconPath
 * (.../apps_icon/all/3201907018807/...). catalog maps the Tizen id to that numeric one, for every app that has
 * both; an app without a numbered icon path (the dev-mode ones: Nuvio, Free My TV itself) keeps its own id, which
 * the status API already answers to.
 */
var catalog = {};

function refreshCatalog() {
  try {
    tizen.application.getAppsInfo(function (list) {
      var found = {};
      for (var i = 0; i < list.length; i++) {
        var m = /\/apps_icon\/all\/(\d+)\//.exec(list[i].iconPath || '');
        if (m) found[list[i].id] = m[1];
      }
      catalog = found;
    }, function () {}, null);
  } catch (e) { /* no change: keep the catalog from the last successful read */ }
}

/** {running, visible} for one app, or null when the TV doesn't say. */
function appStatus(id, done) {
  get('/api/v2/applications/' + encodeURIComponent(catalog[id] || id), function (value) {
    done(value && typeof value.running === 'boolean' && typeof value.visible === 'boolean' ? value : null);
  });
}

/** Every known app at once: which run, and the one on screen. */
function snapshot(done) {
  var ids = state.apps.slice(), left = ids.length, out = {running: {}, visible: null};
  if (!left) { done(out); return; }
  ids.forEach(function (id) {
    appStatus(id, function (value) {
      out.running[id] = !!(value && value.running);
      if (value && value.visible) out.visible = id;
      if (--left === 0) done(out);
    });
  });
}

function forget() {
  state.watched = null; state.seen = false; state.ran = false;
  state.watchedHiddenSince = 0; state.stoppedSince = 0;
}

/** Another app came up (on screen, or newly running): follow it instead of taking the screen back. */
function standAside(result, known) {
  var id = result.visible;
  if (!id) {
    for (var key in result.running) {
      if (key !== known && result.running[key] && !state.running[key]) { id = key; break; }
    }
  }
  state.running = result.running;
  if (!id) return false;
  forget();
  state.watched = id;
  state.seen = result.visible === id;
  state.last = 'following ' + id;
  return true;
}

function launchSelf(why) {
  if (stopped || state.leaving || state.frame !== false || Date.now() - state.lastLaunch < MIN_GAP) return;
  state.lastLaunch = Date.now();
  state.launches += 1;
  forget();
  try {
    tizen.application.launch(SELF, function () { state.last = 'opened: ' + why; },
      function (e) { state.last = 'open failed: ' + (e && e.message); });
  } catch (e) {
    state.last = 'open threw: ' + e.message;
  }
}

function tick() {
  if (stopped || busy || state.leaving || state.frame !== false) return;
  busy = true;
  var mine = epoch, finished = false;
  var watchdog = setTimeout(done, 2000);
  function done() {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    busy = false;
  }
  function valid() { return !finished && !stopped && !state.leaving && mine === epoch; }
  appStatus(SELF, function (me) {
    if (!valid() || !me) { done(); return; }
    var now = Date.now();
    if (me.visible) {
      state.selfVisible = true;
      state.hiddenSince = 0;
      if (now - state.watchAt >= COVER_GRACE) forget();
      if (now - state.scanAt > SCAN) {
        state.scanAt = now;
        snapshot(function (result) { if (valid()) state.running = result.running; done(); });
      } else {
        done();
      }
      return;
    }
    if (state.selfVisible !== false) state.hiddenSince = now;
    state.selfVisible = false;
    var settling = now - state.hiddenSince < HIDDEN_GRACE || now - state.watchAt < APP_GRACE;
    if (state.watched) { watchedApp(valid, done); return; }
    if (settling) { done(); return; }
    snapshot(function (result) {
      if (valid() && !standAside(result)) launchSelf('Samsung Home on screen');
      done();
    });
  });
}

/** Free My TV is hidden behind an app it knows: Home pressed there shows Samsung Home, and the app goes off screen. */
function watchedApp(valid, done) {
  var id = state.watched;
  appStatus(id, function (app) {
    if (!valid() || state.watched !== id || !app) { done(); return; }
    var now = Date.now();
    if (app.visible) {
      state.seen = true;
      state.watchedHiddenSince = 0;
    } else if (state.seen) {
      launchSelf('Home pressed in ' + id);
    } else if (app.running) {
      // Some apps (YouTube, some players) never say they're on screen: follow one that does, opened meanwhile.
      state.ran = true;
      state.stoppedSince = 0;
      if (now - state.scanAt >= SCAN) {
        state.scanAt = now;
        snapshot(function (result) {
          if (valid() && state.watched === id && result.visible && result.visible !== id) standAside(result, id);
          done();
        });
        return;
      }
    } else if (state.ran) {
      // It ran and stopped, so it closed: it can't be covering the home screen.
      if (!state.stoppedSince) state.stoppedSince = now;
      if (now - state.stoppedSince >= STOP_GRACE) forget();
    }
    done();
  });
}

/** Frame TVs hide everything behind Art Mode: the watcher stays off there, untested. */
function discover() {
  get('/api/v2/', function (info) {
    var device = info && info.device;
    if (!device) { retry = setTimeout(discover, 5000); return; }
    var flag = device.FrameTVSupport;
    state.frame = flag === true || flag === 'true';
    if (state.frame) { state.last = 'Frame TV: watcher off'; return; }
    refreshCatalog();
    catalogTimer = setInterval(refreshCatalog, CATALOG_REFRESH);
    interval = setInterval(tick, TICK);
    var uptime = 0;
    try { uptime = require('os').uptime(); } catch (e) { uptime = 0; }
    if (uptime < BOOT_UPTIME) bootTimer = setTimeout(function () { launchSelf('TV turned on'); }, BOOT_DELAY);
  });
}

function request(req, res) {
  var parsed = url.parse(req.url, true), query = parsed.query;
  epoch += 1;   // whatever a scan in progress found is out of date now
  if (parsed.pathname === '/watch') {
    forget();
    state.watched = typeof query.id === 'string' && query.id ? query.id : null;
    state.watchAt = Date.now();
    state.leaving = false;
  } else if (parsed.pathname === '/apps' && typeof query.ids === 'string') {
    var ids = query.ids.split(',').filter(Boolean).slice(0, 200);
    if (ids.indexOf(VIEWER) < 0) ids.push(VIEWER);
    state.apps = ids;
    state.scanAt = 0;
    refreshCatalog();   // a good moment to catch anything installed since the last read
  } else if (parsed.pathname === '/leave') {
    state.leaving = true;
    forget();
  } else if (parsed.pathname === '/home') {
    state.leaving = false;
    forget();
  }
  res.writeHead(200, {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(state));
}

module.exports.onStart = function () {
  if (server) return;
  server = http.createServer(request);
  server.listen(PORT, '127.0.0.1');
  discover();
};

module.exports.onRequest = function () {};

module.exports.onExit = function () {
  stopped = true;
  clearInterval(interval);
  clearInterval(catalogTimer);
  clearTimeout(retry);
  clearTimeout(bootTimer);
  if (server) { server.close(); server = null; }
};
