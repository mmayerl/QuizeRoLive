/* =========================================================================
   app.js - screen flow, geolocation, arrival detection, quiz and scoring.
   ========================================================================= */
(function (global) {
  'use strict';

  var doc = global.document;
  var $ = function (id) { return doc.getElementById(id); };

  var CONFIG_URL = 'data/locations.json';
  var SCREENS = ['start', 'map', 'quiz', 'end'];
  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  var cfg = null;            // parsed locations.json
  var locations = [];
  var defaultRadius = 35;

  var screen = 'start';
  var userPos = null;        // { lat, lon, accuracy }
  var simulated = null;      // test mode position
  var heading = null;        // degrees, from the compass
  var watchId = null;
  var compass = null;
  var wakeLock = null;
  var quizLocked = false;
  var mapStarted = false;

  /* ===================================================================== */
  /*  boot                                                                 */
  /* ===================================================================== */

  function boot() {
    fetch(CONFIG_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(setup)
      .catch(function (err) {
        startError(
          'Die Spieldaten (data/locations.json) konnten nicht geladen werden: ' + err.message +
          '. Bitte die Seite über einen Webserver aufrufen, nicht als Datei (file://).'
        );
      });
  }

  function setup(data) {
    cfg = data;
    locations = (data.locations || []).filter(function (l) {
      return l && l.id && typeof l.lat === 'number' && typeof l.lon === 'number' && l.question;
    });
    if (!locations.length) {
      startError('In data/locations.json ist kein gültiger Ort definiert.');
      return;
    }
    defaultRadius = (data.game && data.game.defaultRadiusMeters) || 35;

    var signature = ((data.game && data.game.version) || '0') + '|' +
                    locations.map(function (l) { return l.id; }).join(',');
    GameState.init(signature);

    if (data.game) {
      if (data.game.title) $('start-title').textContent = data.game.title;
      if (data.game.subtitle) $('start-sub').textContent = data.game.subtitle;
      if (data.game.title) doc.title = data.game.title + ' – FH des BFI Wien';
    }

    wireEvents();

    var st = GameState.state;
    $('team-name').value = st.team || '';

    if (st.finishedAt || (GameState.answeredCount() >= locations.length && st.startedAt)) {
      renderEnd();
      show('end');
    } else if (GameState.hasProgress()) {
      $('btn-resume').hidden = false;
      $('btn-reset-start').hidden = false;
      $('btn-start').textContent = 'Neues Spiel starten';
      show('start');
    } else {
      show('start');
    }

    if (!GameState.isPersistent()) {
      startError('Achtung: Dieser Browser speichert nichts dauerhaft (privater Modus?). ' +
                 'Der Spielstand geht beim Schließen der Seite verloren.');
    }
  }

  function startError(msg) {
    var el = $('start-error');
    el.textContent = msg;
    el.hidden = false;
  }

  /* ===================================================================== */
  /*  screens                                                              */
  /* ===================================================================== */

  function show(name) {
    screen = name;
    SCREENS.forEach(function (n) { $('screen-' + n).hidden = (n !== name); });
    if (name === 'map') {
      GameMap.resize();
      // The map container was hidden while the quiz was open; MapLibre needs a
      // second nudge once layout has settled.
      global.setTimeout(function () { GameMap.resize(); }, 60);
    }
    if (name !== 'start') GameState.setScreen(name);
  }

  /* ===================================================================== */
  /*  events                                                               */
  /* ===================================================================== */

  function wireEvents() {
    $('btn-start').addEventListener('click', function () {
      if (GameState.hasProgress()) {
        if (!global.confirm('Ein gespeichertes Spiel wird dabei gelöscht. Wirklich neu starten?')) return;
        GameState.reset();
      }
      startGame($('team-name').value.trim());
    });

    $('btn-resume').addEventListener('click', function () {
      startGame(GameState.state.team || $('team-name').value.trim());
    });

    $('btn-reset-start').addEventListener('click', function () {
      if (!global.confirm('Gespeichertes Spiel wirklich verwerfen?')) return;
      GameState.reset();
      global.location.reload();
    });

    $('btn-recenter').addEventListener('click', function () {
      var p = activePos();
      if (p) GameMap.recenter(p.lat, p.lon);
      else GameMap.fitAll(locations, null);
    });

    $('btn-zoom-in').addEventListener('click', function () { GameMap.zoomBy(1); });
    $('btn-zoom-out').addEventListener('click', function () { GameMap.zoomBy(-1); });

    $('btn-compass').addEventListener('click', function () {
      var next = !GameMap.headingUp;
      if (next && heading === null) {
        banner('Keine Kompassdaten verfügbar – die Karte bleibt nach Norden ausgerichtet.', true, 4000);
        GameMap.setHeadingUp(false);
      } else {
        GameMap.setHeadingUp(next);
      }
      GameState.setUi('headingUp', GameMap.headingUp);
      updateNeedle();
    });

    $('btn-quiz-next').addEventListener('click', afterQuestion);

    $('btn-restart').addEventListener('click', function () {
      if (!global.confirm('Neues Spiel starten? Der aktuelle Punktestand wird gelöscht.')) return;
      GameState.reset();
      global.location.reload();
    });

    // Five taps on the logo toggle the test mode (position by tapping the map).
    var taps = [], mark = $('topbar-mark');
    mark.addEventListener('click', function () {
      var now = Date.now();
      taps = taps.filter(function (t) { return now - t < 3000; });
      taps.push(now);
      if (taps.length >= 5) {
        taps = [];
        toggleDevMode(!GameState.state.ui.dev);
      }
    });

    $('banner').addEventListener('click', function () { this.hidden = true; });

    global.addEventListener('resize', function () { GameMap.resize(); });
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') requestWakeLock();
    });
  }

  /* ===================================================================== */
  /*  starting the hunt                                                    */
  /* ===================================================================== */

  function startGame(teamName) {
    GameState.begin(teamName || 'Team ohne Namen');

    // iOS only grants motion access when asked from inside a user gesture,
    // which is exactly where we are right now.
    compass = new Geo.Compass(onHeading);
    compass.start().then(function (ok) {
      if (!ok) banner('Kompass nicht verfügbar – die Blickrichtung wird geschätzt.', false, 5000);
    });

    if (!mapStarted) {
      var ok = GameMap.init({
        container: 'map',
        config: (cfg.game && cfg.game.map) || {},
        onMapClick: onMapClick,
        onUserGesture: updateNeedle,
        onReady: function () {
          refreshTargets();
          GameMap.setHeadingUp(!!GameState.state.ui.headingUp);
          var p = activePos();
          if (p) GameMap.setUser(p.lat, p.lon, p.accuracy);
          else GameMap.fitAll(locations, null);
          GameMap.map.on('rotate', updateNeedle);
          updateNeedle();
        }
      });
      if (!ok) {
        startError('Die Karte kann auf diesem Gerät nicht angezeigt werden (WebGL fehlt). ' +
                   'Bitte einen aktuellen Browser verwenden.');
        return;
      }
      mapStarted = true;
    }

    toggleDevMode(!!GameState.state.ui.dev, true);
    startGeolocation();
    requestWakeLock();
    updateHud();
    show('map');

    // A question that was already revealed must be answered - reloading the
    // page is not a way to get a different one.
    var open = GameState.state.open;
    if (open) {
      var loc = byId(open.id);
      if (loc) { renderQuestion(loc, open.order); return; }
      GameState.state.open = null;
      GameState.save();
    }

    if (GameState.answeredCount() >= locations.length) finishGame();
  }

  /* ===================================================================== */
  /*  positioning                                                          */
  /* ===================================================================== */

  function activePos() {
    return GameState.state.ui.dev ? simulated : userPos;
  }

  function startGeolocation() {
    if (!('geolocation' in global.navigator)) {
      banner('Dieses Gerät kann den Standort nicht bestimmen.', true);
      return;
    }
    if (watchId !== null) return;
    watchId = global.navigator.geolocation.watchPosition(
      function (pos) {
        userPos = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy || 0
        };
        // GPS course is a good stand-in while walking if there is no compass.
        if (heading === null && typeof pos.coords.heading === 'number' &&
            !isNaN(pos.coords.heading) && pos.coords.speed > 0.7) {
          GameMap.setHeading(pos.coords.heading);
        }
        hideBanner();
        onPositionUpdate();
      },
      function (err) {
        if (GameState.state.ui.dev) return;   // position comes from tapping
        if (err.code === err.PERMISSION_DENIED) {
          banner('Standortfreigabe verweigert. Bitte in den Browser-Einstellungen erlauben und die Seite neu laden.', true);
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          banner('Kein GPS-Signal. Geht ins Freie und wartet einen Moment.', true, 8000);
        } else {
          banner('Standort dauert länger als erwartet…', false, 6000);
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  function onMapClick(lat, lon) {
    if (!GameState.state.ui.dev) return;
    simulated = { lat: lat, lon: lon, accuracy: 5 };
    onPositionUpdate();
  }

  function onHeading(deg) {
    heading = deg;
    GameMap.setHeading(deg);
    updateNeedle();
    updateSheetArrow();
  }

  function onPositionUpdate() {
    var p = activePos();
    if (!p) return;
    GameMap.setUser(p.lat, p.lon, p.accuracy);
    updateSheet();
    checkArrival();
  }

  /* ===================================================================== */
  /*  arrival detection                                                    */
  /* ===================================================================== */

  function openLocations() {
    return locations.filter(function (l) { return !GameState.isAnswered(l.id); });
  }

  function nearestOpen() {
    var p = activePos();
    if (!p) return null;
    var best = null;
    openLocations().forEach(function (l) {
      var d = Geo.distance(p.lat, p.lon, l.lat, l.lon);
      if (!best || d < best.distance) best = { loc: l, distance: d };
    });
    return best;
  }

  function checkArrival() {
    if (screen !== 'map') return;
    if (GameState.state.open) return;
    var near = nearestOpen();
    if (!near) return;
    var radius = near.loc.radiusMeters || defaultRadius;
    GameMap.setNear(near.distance <= radius ? near.loc.id : null);
    if (near.distance <= radius) openQuestion(near.loc);
  }

  /* ===================================================================== */
  /*  quiz                                                                 */
  /* ===================================================================== */

  function openQuestion(loc) {
    var n = loc.question.answers.length;
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    if (!cfg.game || cfg.game.shuffleAnswers !== false) {
      for (var j = order.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var t = order[j]; order[j] = order[k]; order[k] = t;
      }
    }
    // Persisted before anything is displayed: a reload resumes this question.
    GameState.openQuestion(loc.id, order);
    renderQuestion(loc, order);
  }

  function renderQuestion(loc, order) {
    var q = loc.question;
    quizLocked = false;

    $('quiz-eyebrow').textContent = 'Standort erreicht';
    $('quiz-place').textContent = loc.name;
    $('quiz-intro').textContent = loc.intro || '';
    $('quiz-intro').hidden = !loc.intro;
    $('quiz-question').textContent = q.text;
    $('quiz-feedback').hidden = true;
    $('btn-quiz-next').hidden = true;

    var box = $('quiz-answers');
    box.className = 'answers';
    box.innerHTML = '';

    order.forEach(function (originalIndex, slot) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'answer';
      btn.dataset.index = String(originalIndex);
      btn.innerHTML = '<span class="answer__key"></span><span class="answer__txt"></span>';
      btn.firstChild.textContent = LETTERS[slot] || String(slot + 1);
      btn.lastChild.textContent = q.answers[originalIndex];
      btn.addEventListener('click', function () { answer(loc, originalIndex, btn); });
      box.appendChild(btn);
    });

    show('quiz');
    $('screen-quiz').querySelector('.quiz__scroll').scrollTop = 0;
  }

  function answer(loc, chosenIndex, btn) {
    if (quizLocked) return;
    quizLocked = true;

    var q = loc.question;
    var correct = chosenIndex === q.correctIndex;
    var points = typeof loc.points === 'number' ? loc.points : 1;

    var box = $('quiz-answers');
    box.classList.add('is-locked');
    Array.prototype.forEach.call(box.children, function (el) {
      if (Number(el.dataset.index) === q.correctIndex) el.classList.add('is-correct');
    });
    if (!correct) btn.classList.add('is-wrong');

    GameState.recordAnswer(loc.id, chosenIndex, correct, points);

    var fb = $('quiz-feedback');
    fb.className = 'feedback ' + (correct ? 'is-ok' : 'is-bad');
    $('feedback-head').textContent = correct
      ? 'Richtig! +' + points + (points === 1 ? ' Punkt' : ' Punkte')
      : 'Leider falsch – kein Punkt.';
    $('feedback-body').textContent = q.explanation || '';
    $('feedback-body').hidden = !q.explanation;
    fb.hidden = false;

    $('btn-quiz-next').hidden = false;
    $('btn-quiz-next').textContent =
      GameState.answeredCount() >= locations.length ? 'Zur Auswertung' : 'Weiter zur Karte';

    if (global.navigator.vibrate) global.navigator.vibrate(correct ? 60 : [40, 60, 40]);
    updateHud();
    refreshTargets();
  }

  function afterQuestion() {
    if (GameState.answeredCount() >= locations.length) { finishGame(); return; }
    GameMap.setNear(null);
    show('map');
    updateSheet();
    // Do not re-trigger the location we are still standing in - it is answered
    // now, so checkArrival only looks at the remaining ones.
    checkArrival();
  }

  /* ===================================================================== */
  /*  HUD + sheet                                                          */
  /* ===================================================================== */

  function updateHud() {
    var st = GameState.state;
    var done = GameState.answeredCount();
    $('hud-team').textContent = st.team || 'Team';
    $('hud-progress').textContent = done + ' von ' + locations.length + ' Orten';
    $('hud-score').textContent = String(GameState.score());
    $('hud-bar').style.width = (locations.length ? (done / locations.length) * 100 : 0) + '%';
  }

  function refreshTargets() {
    GameMap.setTargets(locations, GameState.state.results, defaultRadius, function (loc) {
      banner(loc.name + (GameState.isAnswered(loc.id) ? ' – bereits erledigt.' : ' – ' + (loc.hint || 'noch offen.')), false, 4000);
    });
    updateHud();
  }

  function updateSheet() {
    if (!openLocations().length) {
      $('sheet-name').textContent = 'Alle Orte erledigt';
      $('sheet-hint').textContent = '';
      $('sheet-dist').textContent = '✓';
      $('sheet-acc').textContent = '';
      return;
    }
    var near = nearestOpen();
    if (!near) {                        // locations left, but no fix yet
      $('sheet-name').textContent = 'Suche euren Standort…';
      $('sheet-hint').textContent = GameState.state.ui.dev
        ? 'Testmodus: auf die Karte tippen'
        : 'Bitte GPS und Standortfreigabe aktivieren';
      $('sheet-dist').textContent = '–';
      $('sheet-acc').textContent = '';
      return;
    }
    $('sheet-name').textContent = near.loc.name;
    $('sheet-hint').textContent = near.loc.hint || '';
    $('sheet-dist').textContent = Geo.formatDistance(near.distance);

    var p = activePos();
    if (GameState.state.ui.dev) {
      $('sheet-acc').textContent = 'Testmodus – Position wird per Tippen gesetzt.';
    } else if (p && p.accuracy) {
      $('sheet-acc').textContent = 'GPS-Genauigkeit ±' + Math.round(p.accuracy) + ' m' +
        (p.accuracy > 40 ? ' – für genaue Treffer bitte ins Freie gehen.' : '');
    } else {
      $('sheet-acc').textContent = 'Warte auf GPS-Signal…';
    }
    updateSheetArrow(near);
  }

  function updateSheetArrow(near) {
    near = near || nearestOpen();
    var p = activePos();
    var arrow = $('sheet-arrow');
    if (!near || !p) { arrow.style.transform = 'rotate(0deg)'; return; }
    var brg = Geo.bearing(p.lat, p.lon, near.loc.lat, near.loc.lon);
    // Relative to where the phone is pointing, or to the map if no compass.
    var reference = heading !== null ? heading : GameMap.getBearing();
    arrow.style.transform = 'rotate(' + (brg - reference) + 'deg)';
  }

  function updateNeedle() {
    var needle = $('needle');
    if (needle) needle.style.transform = 'rotate(' + (-GameMap.getBearing()) + 'deg)';
    $('btn-compass').classList.toggle('is-off', !GameMap.headingUp);
    $('btn-compass').title = GameMap.headingUp
      ? 'Karte dreht mit der Blickrichtung – tippen für Norden oben'
      : 'Norden oben – tippen, damit die Karte mitdreht';
  }

  /* ===================================================================== */
  /*  end screen                                                           */
  /* ===================================================================== */

  function finishGame() {
    GameState.finish();
    releaseWakeLock();
    if (watchId !== null) {
      global.navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (compass) compass.stop();
    renderEnd();
    show('end');
  }

  function renderEnd() {
    var st = GameState.state;
    var score = GameState.score();
    var max = locations.reduce(function (s, l) {
      return s + (typeof l.points === 'number' ? l.points : 1);
    }, 0);

    $('end-team').textContent = st.team || 'Euer Team';
    $('end-points').textContent = String(score);
    $('end-max').textContent = 'von ' + max + ' Punkten';

    var ratio = max ? score / max : 0;
    $('end-verdict').textContent =
      ratio === 1 ? 'Perfekt! Alle Fragen richtig – ihr kennt euch hier schon besser aus als manche im dritten Semester.'
      : ratio >= 0.75 ? 'Starke Leistung! Nur ein paar Fragen sind euch durchgerutscht.'
      : ratio >= 0.5 ? 'Solide Runde. Die Hälfte sitzt schon – der Rest kommt im Studium dazu.'
      : 'Angekommen ist angekommen. Den Campus kennt ihr jetzt jedenfalls.';

    var list = $('end-results');
    list.innerHTML = '';
    locations.forEach(function (loc) {
      var res = st.results[loc.id];
      var li = doc.createElement('li');
      var pts = res && res.correct ? (typeof loc.points === 'number' ? loc.points : 1) : 0;
      li.innerHTML =
        '<span class="results__badge ' + (pts ? 'ok' : 'bad') + '">' + (pts ? '✓' : '✕') + '</span>' +
        '<span class="results__name"></span>' +
        '<span class="results__pts">' + pts + ' P.</span>';
      li.querySelector('.results__name').textContent = loc.name;
      list.appendChild(li);
    });

    $('end-time').textContent = (st.startedAt && st.finishedAt)
      ? 'Gesamtdauer: ' + Geo.formatDuration(st.finishedAt - st.startedAt)
      : '';
  }

  /* ===================================================================== */
  /*  misc                                                                 */
  /* ===================================================================== */

  function byId(id) {
    for (var i = 0; i < locations.length; i++) if (locations[i].id === id) return locations[i];
    return null;
  }

  var bannerTimer = null;
  function banner(msg, isWarning, autoHideMs) {
    var el = $('banner');
    el.textContent = msg;
    el.className = 'banner' + (isWarning ? ' is-warn' : '');
    el.hidden = false;
    global.clearTimeout(bannerTimer);
    if (autoHideMs) bannerTimer = global.setTimeout(hideBanner, autoHideMs);
  }
  /** Warnings stay until the problem clears or the player taps them away. */
  function hideBanner() {
    var el = $('banner');
    if (el.className.indexOf('is-warn') < 0) el.hidden = true;
  }

  /** @param {boolean} silent - true while restoring the saved preference. */
  function toggleDevMode(on, silent) {
    GameState.setUi('dev', !!on);
    $('devbadge').hidden = !on;
    if (on) {
      simulated = simulated || userPos ||
        { lat: locations[0].lat, lon: locations[0].lon, accuracy: 5 };
      if (!silent) banner('Testmodus aktiv: Auf die Karte tippen setzt eure Position.', false, 5000);
    } else if (!silent) {
      banner('Testmodus aus – wieder echtes GPS.', false, 3000);
    }
    onPositionUpdate();
    updateSheet();
  }

  function requestWakeLock() {
    if (!('wakeLock' in global.navigator) || screen === 'start') return;
    global.navigator.wakeLock.request('screen')
      .then(function (lock) { wakeLock = lock; })
      .catch(function () { /* not critical */ });
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
