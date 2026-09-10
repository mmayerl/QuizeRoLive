/* =========================================================================
   editor.js - the staff tool for authoring a QuizeRo locations file.

   Standalone: it never touches the game's saved state and the game never
   loads this file. What it does share is geo.js (distance / circle maths)
   and basemap.js (how a basemap is built from a `game.map` block), so the
   editor's map behaves exactly like the one the students will see.

   The document loaded from disk is mutated in place and written back out, so
   any keys this editor does not know about - `_readme`, future additions -
   survive a round trip untouched.
   ========================================================================= */
(function (global) {
  'use strict';

  var doc = global.document;
  var $ = function (id) { return doc.getElementById(id); };

  var DRAFT_KEY = 'quizero-editor/draft/v1';
  var GAME_FILE = 'data/locations.json';
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var GEO_MIN_INTERVAL = 1100;   // Nominatim asks for <= 1 request/second

  var model = null;        // the whole JSON document
  var fileName = 'locations.json';
  var selectedId = null;
  var dirty = false;
  var versionAtLoad = '';
  var map = null;
  var markers = {};        // id -> maplibregl.Marker
  var placingId = null;    // location awaiting a click on the map
  var lastGeocode = 0;
  var issues = [];

  /* ===================================================================== */
  /*  document helpers                                                     */
  /* ===================================================================== */

  function blankDocument() {
    return {
      _readme: [
        'Erstellt mit dem QuizeRo-Editor (editor.html).',
        "Nach jeder Änderung 'version' erhöhen, damit alte Spielstände auf den",
        'Handys der Studierenden verworfen werden.'
      ],
      game: {
        version: '1.0.0',
        title: 'QuizeRo',
        subtitle: 'Die Schnitzeljagd für Erstsemestrige',
        defaultRadiusMeters: 40,
        shuffleAnswers: true,
        map: {
          tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
          maxZoom: 19,
          initialZoom: 15,
          initialCenter: { lat: 48.18885, lon: 16.40472 }
        }
      },
      locations: []
    };
  }

  function blankLocation(centre) {
    return {
      id: uniqueId('ort'),
      name: '',
      hint: '',
      intro: '',
      lat: round6(centre.lat),
      lon: round6(centre.lon),
      radiusMeters: model.game.defaultRadiusMeters || 40,
      points: 1,
      question: {
        text: '',
        answers: ['', '', '', ''],
        correctIndex: 0,
        explanation: ''
      }
    };
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  function slugify(s) {
    return String(s).toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ort';
  }

  function uniqueId(base) {
    var ids = {}, i;
    for (i = 0; i < model.locations.length; i++) ids[model.locations[i].id] = true;
    if (!ids[base]) return base;
    for (i = 2; ; i++) if (!ids[base + '-' + i]) return base + '-' + i;
  }

  function byId(id) {
    for (var i = 0; i < model.locations.length; i++) {
      if (model.locations[i].id === id) return model.locations[i];
    }
    return null;
  }

  function indexOfId(id) {
    for (var i = 0; i < model.locations.length; i++) {
      if (model.locations[i].id === id) return i;
    }
    return -1;
  }

  /** Fills in anything a hand-written file may be missing, without clobbering. */
  function normalise(d) {
    if (!d || typeof d !== 'object') throw new Error('Die Datei enthält kein JSON-Objekt.');
    if (!Array.isArray(d.locations)) throw new Error('Die Datei hat kein "locations"-Array.');
    var blank = blankDocument();
    d.game = d.game || {};
    Object.keys(blank.game).forEach(function (k) {
      if (k === 'map') return;
      if (d.game[k] === undefined) d.game[k] = blank.game[k];
    });
    d.game.map = d.game.map || {};
    Object.keys(blank.game.map).forEach(function (k) {
      if (d.game.map[k] === undefined) d.game.map[k] = blank.game.map[k];
    });
    d.locations.forEach(function (l, i) {
      if (!l.id) l.id = 'ort-' + (i + 1);
      if (l.name === undefined) l.name = l.id;
      if (l.points === undefined) l.points = 1;
      l.question = l.question || {};
      if (!Array.isArray(l.question.answers)) l.question.answers = ['', ''];
      if (l.question.text === undefined) l.question.text = '';
      if (typeof l.question.correctIndex !== 'number') l.question.correctIndex = 0;
    });
    return d;
  }

  /* ===================================================================== */
  /*  loading / saving                                                     */
  /* ===================================================================== */

  function adopt(d, name) {
    model = normalise(d);
    fileName = name || 'locations.json';
    versionAtLoad = model.game.version || '';
    selectedId = model.locations.length ? model.locations[0].id : null;
    setDirty(false);
    $('file-name').textContent = fileName;
    renderAll();
    fitAll();
  }

  function openFile(file) {
    var reader = new global.FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        toast('Die Datei ist kein gültiges JSON: ' + e.message, true);
        return;
      }
      try {
        adopt(parsed, file.name);
        toast(model.locations.length + ' Orte geladen.');
      } catch (e) {
        toast(e.message, true);
      }
    };
    reader.onerror = function () { toast('Die Datei konnte nicht gelesen werden.', true); };
    reader.readAsText(file, 'utf-8');
  }

  function loadGameFile() {
    global.fetch(GAME_FILE, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        adopt(d, 'locations.json');
        toast('Spieldatei geladen (' + model.locations.length + ' Orte).');
      })
      .catch(function (e) {
        toast('data/locations.json konnte nicht geladen werden: ' + e.message, true);
      });
  }

  function serialise() {
    return JSON.stringify(model, null, 2) + '\n';
  }

  function download() {
    var blocking = issues.filter(function (i) { return i.level === 'error'; });
    if (blocking.length) {
      if (!global.confirm(blocking.length + ' Problem(e) sind noch offen. Die Datei kann im Spiel '
        + 'Fehler verursachen.\n\nTrotzdem herunterladen?')) return;
    }
    var blob = new global.Blob([serialise()], { type: 'application/json;charset=utf-8' });
    var url = global.URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.json$/i, '') + '.json';
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1000);
    setDirty(false);
    toast('Heruntergeladen. Datei nach data/ kopieren, um sie ins Spiel zu übernehmen.');
  }

  function setDirty(v) {
    dirty = v;
    $('file-dirty').hidden = !v;
    if (v) saveDraft();
  }

  function saveDraft() {
    try {
      global.localStorage.setItem(DRAFT_KEY, JSON.stringify({
        at: Date.now(), name: fileName, doc: model
      }));
    } catch (e) { /* storage full or blocked - not critical */ }
  }

  function clearDraft() {
    try { global.localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  function readDraft() {
    try {
      var raw = global.localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ===================================================================== */
  /*  validation                                                           */
  /* ===================================================================== */

  function validate() {
    issues = [];
    var seen = {};

    if (!model.game.version) {
      issues.push({ level: 'error', msg: 'Es ist keine Version gesetzt.' });
    } else if (dirty && model.game.version === versionAtLoad) {
      issues.push({
        level: 'warn',
        msg: 'Die Version wurde nicht erhöht. Ohne Erhöhung behalten Handys mit einem ' +
             'laufenden Spiel die alten Fragen.'
      });
    }

    model.locations.forEach(function (l, i) {
      var where = 'Ort ' + (i + 1) + ' (' + (l.name || l.id) + '): ';
      var add = function (level, msg) {
        issues.push({ level: level, msg: where + msg, id: l.id });
      };

      if (!l.id) add('error', 'ohne id.');
      else if (seen[l.id]) add('error', 'die id "' + l.id + '" ist doppelt vergeben.');
      else if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(l.id)) {
        add('error', 'die id darf nur Buchstaben, Ziffern, - und _ enthalten.');
      }
      seen[l.id] = true;

      if (!String(l.name || '').trim()) add('error', 'kein Name.');
      if (typeof l.lat !== 'number' || isNaN(l.lat) || l.lat < -90 || l.lat > 90) {
        add('error', 'ungültige Breite (lat).');
      }
      if (typeof l.lon !== 'number' || isNaN(l.lon) || l.lon < -180 || l.lon > 180) {
        add('error', 'ungültige Länge (lon).');
      }
      var r = l.radiusMeters || model.game.defaultRadiusMeters;
      if (!(r > 0)) add('error', 'Radius muss größer als 0 sein.');
      else if (r < 15) add('warn', 'Radius unter 15 m - bei Stadt-GPS kaum erreichbar.');

      if (!String(l.question.text || '').trim()) add('error', 'keine Frage.');
      var answers = l.question.answers || [];
      var filled = answers.filter(function (a) { return String(a || '').trim(); });
      if (filled.length < 2) add('error', 'mindestens zwei Antworten nötig.');
      else if (filled.length < answers.length) add('error', 'eine Antwort ist leer.');
      if (l.question.correctIndex < 0 || l.question.correctIndex >= answers.length) {
        add('error', 'keine gültige richtige Antwort markiert.');
      }
    });

    // Overlapping trigger zones fire the wrong question, so flag them.
    for (var a = 0; a < model.locations.length; a++) {
      for (var b = a + 1; b < model.locations.length; b++) {
        var la = model.locations[a], lb = model.locations[b];
        if (typeof la.lat !== 'number' || typeof lb.lat !== 'number') continue;
        var d = global.Geo.distance(la.lat, la.lon, lb.lat, lb.lon);
        var ra = la.radiusMeters || model.game.defaultRadiusMeters;
        var rb = lb.radiusMeters || model.game.defaultRadiusMeters;
        if (d < ra + rb) {
          issues.push({
            level: 'warn', id: la.id,
            msg: '"' + la.name + '" und "' + lb.name + '" überlappen sich (' +
                 Math.round(d) + ' m Abstand, Radien ' + ra + ' + ' + rb + ' m).'
          });
        }
      }
    }

    // A location far from the rest is usually swapped lat/lon or a typo.
    if (model.locations.length > 2) {
      var pts = model.locations.filter(function (l) { return typeof l.lat === 'number'; });
      var mlat = median(pts.map(function (l) { return l.lat; }));
      var mlon = median(pts.map(function (l) { return l.lon; }));
      pts.forEach(function (l) {
        var d = global.Geo.distance(mlat, mlon, l.lat, l.lon);
        if (d > 5000) {
          issues.push({
            level: 'warn', id: l.id,
            msg: '"' + l.name + '" liegt ' + global.Geo.formatDistance(d) +
                 ' von den anderen Orten entfernt. Sind lat und lon vertauscht?'
          });
        }
      });
    }
    return issues;
  }

  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  function issuesFor(id) {
    return issues.filter(function (i) { return i.id === id; });
  }

  /* ===================================================================== */
  /*  rendering                                                            */
  /* ===================================================================== */

  function renderAll() {
    renderGameSettings();
    validate();
    renderList();
    renderIssues();
    renderMap();
  }

  /** Re-validates and refreshes everything except the open form (keeps focus). */
  function touch() {
    setDirty(true);
    validate();
    renderListLabels();
    renderIssues();
    renderMap();
  }

  function renderGameSettings() {
    var g = model.game;
    $('g-title').value = g.title || '';
    $('g-subtitle').value = g.subtitle || '';
    $('g-version').value = g.version || '';
    $('g-radius').value = g.defaultRadiusMeters || 40;
    $('g-shuffle').checked = g.shuffleAnswers !== false;
    $('g-tileurl').value = g.map.tileUrl || '';
    $('g-tileattr').value = g.map.tileAttribution || '';
    $('g-zoom').value = g.map.initialZoom || 15;
    renderCentreText();
  }

  function renderCentreText() {
    var c = model.game.map.initialCenter || {};
    $('g-centre-txt').textContent =
      'Aktuell: ' + (c.lat != null ? c.lat + ', ' + c.lon : 'nicht gesetzt');
  }

  function renderList() {
    var list = $('loclist');
    list.innerHTML = '';
    $('loc-count').textContent = model.locations.length;
    $('loc-empty').hidden = model.locations.length > 0;

    model.locations.forEach(function (loc, i) {
      var li = doc.createElement('li');
      li.className = 'locitem' + (loc.id === selectedId ? ' is-open' : '');
      li.dataset.id = loc.id;

      var row = doc.createElement('button');
      row.type = 'button';
      row.className = 'locitem__row';
      row.innerHTML =
        '<span class="locitem__n"></span>' +
        '<span class="locitem__txt"><strong></strong><span></span></span>' +
        '<span class="locitem__flag"></span>';
      row.querySelector('.locitem__n').textContent = String(i + 1);
      row.querySelector('strong').textContent = loc.name || '(ohne Namen)';
      row.querySelector('.locitem__txt span').textContent = summaryLine(loc);
      row.querySelector('.locitem__flag').className = 'locitem__flag ' + flagClass(loc.id);
      row.addEventListener('click', function () { select(loc.id === selectedId ? null : loc.id); });
      li.appendChild(row);

      if (loc.id === selectedId) li.appendChild(buildForm(loc));
      list.appendChild(li);
    });
  }

  /** Cheap refresh of the list rows only - never rebuilds the open form. */
  function renderListLabels() {
    $('loc-count').textContent = model.locations.length;
    Array.prototype.forEach.call($('loclist').children, function (li, i) {
      var loc = model.locations[i];
      if (!loc) return;
      li.dataset.id = loc.id;          // the id is editable, so keep it in sync
      li.querySelector('strong').textContent = loc.name || '(ohne Namen)';
      li.querySelector('.locitem__txt span').textContent = summaryLine(loc);
      li.querySelector('.locitem__flag').className = 'locitem__flag ' + flagClass(loc.id);
      var probs = li.querySelector('.eproblems');
      if (probs) fillProblems(probs, loc.id);
    });
  }

  function summaryLine(loc) {
    var r = loc.radiusMeters || model.game.defaultRadiusMeters;
    var pos = (typeof loc.lat === 'number' && typeof loc.lon === 'number')
      ? loc.lat.toFixed(5) + ', ' + loc.lon.toFixed(5)
      : 'keine Position';
    return loc.id + ' · ' + pos + ' · ' + r + ' m';
  }

  function flagClass(id) {
    var mine = issuesFor(id);
    if (mine.some(function (i) { return i.level === 'error'; })) return 'is-bad';
    if (mine.length) return 'is-warn';
    return '';
  }

  function fillProblems(ul, id) {
    ul.innerHTML = '';
    issuesFor(id).forEach(function (p) {
      var li = doc.createElement('li');
      if (p.level === 'warn') li.className = 'is-warn';
      li.textContent = p.msg;
      ul.appendChild(li);
    });
  }

  /* ------------------------------------------------------- location form */

  function buildForm(loc) {
    var wrap = doc.createElement('div');
    wrap.className = 'locform';

    var field = function (label, value, oninput, opts) {
      opts = opts || {};
      var l = doc.createElement('label');
      l.className = 'efield';
      var s = doc.createElement('span');
      s.textContent = label;
      var input = doc.createElement(opts.textarea ? 'textarea' : 'input');
      if (!opts.textarea) input.type = opts.type || 'text';
      if (opts.step) input.step = opts.step;
      if (opts.min !== undefined) input.min = opts.min;
      input.value = value === undefined || value === null ? '' : value;
      input.addEventListener('input', function () { oninput(input.value, input); });
      l.appendChild(s); l.appendChild(input);
      return { label: l, input: input };
    };

    var h = function (t) { var e = doc.createElement('h4'); e.textContent = t; return e; };
    var row = function () {
      var d = doc.createElement('div'); d.className = 'erow';
      Array.prototype.forEach.call(arguments, function (x) { d.appendChild(x); });
      return d;
    };

    /* --- identity ------------------------------------------------------ */
    wrap.appendChild(h('Ort'));
    var nameF = field('Name', loc.name, function (v) {
      loc.name = v;
      if (idAuto) {
        var was = loc.id;
        loc.id = uniqueIdExcept(slugify(v), loc);
        idF.input.value = loc.id;
        renameMarker(was, loc.id);
        if (selectedId === was) selectedId = loc.id;
      }
      touch();
    });
    // Keep the id in step with the name only while it still looks generated.
    // A hand-picked id like "mqm" is never overwritten by renaming.
    var idAuto = !loc.name || slugify(loc.name) === loc.id;
    var idF = field('id (Schlüssel im Spielstand)', loc.id, function (v) {
      idAuto = false;
      var old = loc.id;
      loc.id = v.trim();
      if (selectedId === old) selectedId = loc.id;
      renameMarker(old, loc.id);
      touch();
    });
    wrap.appendChild(row(nameF.label, idF.label));

    wrap.appendChild(field('Hinweis (wo genau?)', loc.hint, function (v) {
      loc.hint = v; touch();
    }).label);
    wrap.appendChild(field('Einleitungstext', loc.intro, function (v) {
      loc.intro = v; touch();
    }, { textarea: true }).label);

    /* --- position ------------------------------------------------------ */
    wrap.appendChild(h('Position'));
    var latF = field('Breite (lat)', loc.lat, function (v) {
      loc.lat = v === '' ? null : parseFloat(v); touch();
    }, { type: 'number', step: 'any' });
    var lonF = field('Länge (lon)', loc.lon, function (v) {
      loc.lon = v === '' ? null : parseFloat(v); touch();
    }, { type: 'number', step: 'any' });
    wrap.appendChild(row(latF.label, lonF.label));

    var placeBtn = doc.createElement('button');
    placeBtn.type = 'button';
    placeBtn.className = 'ebtn ebtn--small';
    placeBtn.textContent = 'Position auf der Karte setzen';
    placeBtn.addEventListener('click', function () { armPlacing(loc.id); });

    var geoWrap = doc.createElement('div');
    geoWrap.className = 'geo';
    var searchF = field('Adresse oder Ort suchen', '', function () {}, {});
    searchF.input.placeholder = 'z. B. Marx Halle, Wien';
    var searchBtn = doc.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'ebtn ebtn--small';
    searchBtn.textContent = 'Suchen';
    geoWrap.appendChild(searchF.label);
    geoWrap.appendChild(searchBtn);

    var results = doc.createElement('ul');
    results.className = 'georesults';

    var runSearch = function () {
      geocode(searchF.input.value, results, function (hit) {
        loc.lat = round6(hit.lat);
        loc.lon = round6(hit.lon);
        latF.input.value = loc.lat;
        lonF.input.value = loc.lon;
        results.innerHTML = '';
        touch();
        if (map) map.easeTo({ center: [loc.lon, loc.lat], zoom: Math.max(map.getZoom(), 16), duration: 600 });
      });
    };
    searchBtn.addEventListener('click', runSearch);
    searchF.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });

    var placeRow = doc.createElement('div');
    placeRow.style.marginTop = '10px';
    placeRow.appendChild(placeBtn);
    wrap.appendChild(placeRow);
    wrap.appendChild(geoWrap);
    wrap.appendChild(results);

    var radF = field('Radius (m)', loc.radiusMeters, function (v) {
      loc.radiusMeters = v === '' ? undefined : parseInt(v, 10); touch();
    }, { type: 'number', min: 1, step: 1 });
    var ptsF = field('Punkte', loc.points, function (v) {
      loc.points = v === '' ? 1 : parseInt(v, 10); touch();
    }, { type: 'number', min: 0, step: 1 });
    wrap.appendChild(row(radF.label, ptsF.label));

    /* --- question ------------------------------------------------------ */
    wrap.appendChild(h('Frage'));
    wrap.appendChild(field('Fragetext', loc.question.text, function (v) {
      loc.question.text = v; touch();
    }, { textarea: true }).label);

    var answersBox = doc.createElement('div');
    answersBox.className = 'answers-ed';
    wrap.appendChild(answersBox);
    renderAnswers(answersBox, loc);

    var addAnswer = doc.createElement('button');
    addAnswer.type = 'button';
    addAnswer.className = 'ebtn ebtn--small';
    addAnswer.textContent = '+ Antwort';
    addAnswer.addEventListener('click', function () {
      if (loc.question.answers.length >= 6) { toast('Mehr als sechs Antworten passen nicht aufs Handy.', true); return; }
      loc.question.answers.push('');
      renderAnswers(answersBox, loc);
      touch();
    });
    wrap.appendChild(addAnswer);

    wrap.appendChild(field('Erklärung (nach dem Antworten)', loc.question.explanation, function (v) {
      loc.question.explanation = v; touch();
    }, { textarea: true }).label);

    /* --- per-location problems ----------------------------------------- */
    var probs = doc.createElement('ul');
    probs.className = 'eproblems';
    fillProblems(probs, loc.id);
    wrap.appendChild(probs);

    /* --- actions -------------------------------------------------------- */
    var actions = doc.createElement('div');
    actions.className = 'locform__actions';
    actions.appendChild(mkBtn('▲ Nach oben', function () { move(loc.id, -1); }));
    actions.appendChild(mkBtn('▼ Nach unten', function () { move(loc.id, 1); }));
    actions.appendChild(mkBtn('Duplizieren', function () { duplicate(loc.id); }));
    var spacer = doc.createElement('span');
    spacer.className = 'spacer';
    actions.appendChild(spacer);
    actions.appendChild(mkBtn('Löschen', function () { remove(loc.id); }, 'ebtn--danger'));
    wrap.appendChild(actions);

    return wrap;
  }

  function uniqueIdExcept(base, loc) {
    var taken = {};
    model.locations.forEach(function (l) { if (l !== loc) taken[l.id] = true; });
    if (!taken[base]) return base;
    for (var i = 2; ; i++) if (!taken[base + '-' + i]) return base + '-' + i;
  }

  function mkBtn(label, onClick, extra) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'ebtn ebtn--small' + (extra ? ' ' + extra : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderAnswers(box, loc) {
    box.innerHTML = '';
    loc.question.answers.forEach(function (text, i) {
      var rowEl = doc.createElement('div');
      rowEl.className = 'answer-ed' + (loc.question.correctIndex === i ? ' is-correct' : '');

      var radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = 'correct-' + loc.id;
      radio.checked = loc.question.correctIndex === i;
      radio.title = 'Als richtige Antwort markieren';
      radio.addEventListener('change', function () {
        loc.question.correctIndex = i;
        renderAnswers(box, loc);
        touch();
      });

      var input = doc.createElement('input');
      input.type = 'text';
      input.value = text;
      input.placeholder = 'Antwort ' + String.fromCharCode(65 + i);
      input.addEventListener('input', function () {
        loc.question.answers[i] = input.value;
        touch();
      });

      var del = doc.createElement('button');
      del.type = 'button';
      del.className = 'x';
      del.textContent = '×';
      del.title = 'Antwort entfernen';
      del.addEventListener('click', function () {
        if (loc.question.answers.length <= 2) { toast('Zwei Antworten sind das Minimum.', true); return; }
        loc.question.answers.splice(i, 1);
        if (loc.question.correctIndex >= loc.question.answers.length) {
          loc.question.correctIndex = loc.question.answers.length - 1;
        } else if (loc.question.correctIndex > i) {
          loc.question.correctIndex--;
        }
        renderAnswers(box, loc);
        touch();
      });

      rowEl.appendChild(radio);
      rowEl.appendChild(input);
      rowEl.appendChild(del);
      box.appendChild(rowEl);
    });
  }

  /* ===================================================================== */
  /*  list operations                                                      */
  /* ===================================================================== */

  function select(id) {
    selectedId = id;
    renderList();
    renderMap();
    if (id) {
      var loc = byId(id);
      if (map && loc && typeof loc.lat === 'number') {
        map.easeTo({ center: [loc.lon, loc.lat], duration: 500 });
      }
      var li = $('loclist').querySelector('[data-id="' + cssEscape(id) + '"]');
      if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /** Moves a marker to a new key so an id change does not recreate it. */
  function renameMarker(oldId, newId) {
    if (oldId === newId || !markers[oldId]) return;
    if (markers[newId]) markers[newId].remove();
    markers[newId] = markers[oldId];
    delete markers[oldId];
  }

  function addLocation() {
    var c = map ? map.getCenter() : { lat: 48.18885, lng: 16.40472 };
    var loc = blankLocation({ lat: c.lat, lon: c.lng });
    model.locations.push(loc);
    selectedId = loc.id;
    setDirty(true);
    renderAll();
    toast('Ort angelegt - jetzt Name, Position und Frage ausfüllen.');
  }

  function duplicate(id) {
    var i = indexOfId(id);
    if (i < 0) return;
    var copy = JSON.parse(JSON.stringify(model.locations[i]));
    copy.id = uniqueId(copy.id);
    copy.name = copy.name + ' (Kopie)';
    model.locations.splice(i + 1, 0, copy);
    selectedId = copy.id;
    setDirty(true);
    renderAll();
  }

  function remove(id) {
    var loc = byId(id);
    if (!loc) return;
    if (!global.confirm('"' + (loc.name || id) + '" wirklich löschen?')) return;
    model.locations.splice(indexOfId(id), 1);
    if (markers[id]) { markers[id].remove(); delete markers[id]; }
    if (selectedId === id) selectedId = null;
    setDirty(true);
    renderAll();
  }

  function move(id, delta) {
    var i = indexOfId(id), j = i + delta;
    if (i < 0 || j < 0 || j >= model.locations.length) return;
    var tmp = model.locations[i];
    model.locations[i] = model.locations[j];
    model.locations[j] = tmp;
    setDirty(true);
    renderAll();
  }

  /* ===================================================================== */
  /*  map                                                                  */
  /* ===================================================================== */

  function initMap() {
    map = global.Basemap.create('map', model.game.map, { zoom: model.game.map.initialZoom });
    if (!map) {
      toast('Die Karte braucht WebGL - bitte einen aktuellen Browser verwenden.', true);
      return;
    }
    var ready = function () {
      map.addSource('zones', { type: 'geojson', data: global.Basemap.featureCollection([]) });
      map.addLayer({
        id: 'zones-fill', type: 'fill', source: 'zones',
        paint: {
          'fill-color': ['case', ['get', 'selected'], '#17385F', '#66769A'],
          'fill-opacity': ['case', ['get', 'selected'], 0.18, 0.10]
        }
      });
      map.addLayer({
        id: 'zones-line', type: 'line', source: 'zones',
        paint: {
          'line-color': ['case', ['get', 'selected'], '#17385F', '#66769A'],
          'line-width': ['case', ['get', 'selected'], 2.5, 1.5],
          'line-dasharray': [2, 2]
        }
      });
      renderMap();
      fitAll();
    };
    if (map.isStyleLoaded()) ready();
    else map.once('style.load', ready);

    map.on('click', function (e) {
      if (!placingId) return;
      var loc = byId(placingId);
      placingId = null;
      $('map-hint').hidden = true;
      if (!loc) return;
      loc.lat = round6(e.lngLat.lat);
      loc.lon = round6(e.lngLat.lng);
      setDirty(true);
      validate();
      renderList();          // rebuild so the lat/lon inputs show the new values
      renderIssues();
      renderMap();
    });
  }

  function armPlacing(id) {
    if (!map) { toast('Ohne Karte nicht möglich - bitte lat/lon direkt eintragen.', true); return; }
    placingId = id;
    var hint = $('map-hint');
    hint.textContent = 'Klicke auf die Karte, um die Position zu setzen. (Esc bricht ab.)';
    hint.hidden = false;
  }

  function renderMap() {
    if (!map || !map.getSource('zones')) return;

    var features = model.locations
      .filter(function (l) { return typeof l.lat === 'number' && typeof l.lon === 'number'; })
      .map(function (l) {
        return global.Basemap.circleFeature(
          l.lat, l.lon, l.radiusMeters || model.game.defaultRadiusMeters,
          { selected: l.id === selectedId }
        );
      });
    global.Basemap.setData(map, 'zones', features);

    // Drop markers for locations that no longer exist.
    Object.keys(markers).forEach(function (id) {
      if (!byId(id)) { markers[id].remove(); delete markers[id]; }
    });

    model.locations.forEach(function (loc, i) {
      if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') {
        if (markers[loc.id]) { markers[loc.id].remove(); delete markers[loc.id]; }
        return;
      }
      var entry = markers[loc.id];
      if (!entry) {
        var wrap = doc.createElement('div');
        var pin = doc.createElement('div');
        pin.className = 'pin';
        pin.innerHTML = '<span></span>';
        wrap.appendChild(pin);
        wrap.addEventListener('click', function (ev) {
          ev.stopPropagation();
          select(loc.id);
        });
        entry = markers[loc.id] = new global.maplibregl.Marker({
          element: wrap, anchor: 'bottom', draggable: true
        }).setLngLat([loc.lon, loc.lat]).addTo(map);

        entry.on('dragend', function () {
          var ll = entry.getLngLat();
          var l = byId(loc.id);
          if (!l) return;
          l.lat = round6(ll.lat);
          l.lon = round6(ll.lng);
          setDirty(true);
          validate();
          if (selectedId === l.id) renderList(); else renderListLabels();
          renderIssues();
          renderMap();
        });
      } else {
        entry.setLngLat([loc.lon, loc.lat]);
      }
      var el = entry.getElement().firstChild;
      el.firstChild.textContent = String(i + 1);
      el.className = 'pin' + (loc.id === selectedId ? ' is-sel' : '');
    });
  }

  function fitAll() {
    if (!map) return;
    var pts = model.locations.filter(function (l) { return typeof l.lat === 'number'; });
    if (!pts.length) return;
    var b = new global.maplibregl.LngLatBounds();
    pts.forEach(function (l) { b.extend([l.lon, l.lat]); });
    map.fitBounds(b, { padding: 90, maxZoom: 17, duration: 600 });
  }

  /* ===================================================================== */
  /*  geocoding                                                            */
  /* ===================================================================== */

  function geocode(query, resultsEl, onPick) {
    query = String(query || '').trim();
    resultsEl.innerHTML = '';
    if (query.length < 3) { toast('Bitte mindestens drei Zeichen eingeben.', true); return; }

    var wait = Math.max(0, GEO_MIN_INTERVAL - (Date.now() - lastGeocode));
    var li = doc.createElement('li');
    li.textContent = 'Suche…';
    resultsEl.appendChild(li);

    global.setTimeout(function () {
      lastGeocode = Date.now();
      var url = NOMINATIM + '?format=jsonv2&limit=5&addressdetails=0&q=' + encodeURIComponent(query);
      global.fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (hits) {
          resultsEl.innerHTML = '';
          if (!hits.length) {
            var none = doc.createElement('li');
            none.textContent = 'Nichts gefunden.';
            resultsEl.appendChild(none);
            return;
          }
          hits.forEach(function (hit) {
            var item = doc.createElement('li');
            var parts = String(hit.display_name).split(',');
            item.innerHTML = '<b></b><br>';
            item.querySelector('b').textContent = parts[0];
            item.appendChild(doc.createTextNode(
              parts.slice(1, 4).join(',').trim() + '  ·  ' +
              (+hit.lat).toFixed(5) + ', ' + (+hit.lon).toFixed(5)
            ));
            item.addEventListener('click', function () {
              onPick({ lat: +hit.lat, lon: +hit.lon });
            });
            resultsEl.appendChild(item);
          });
        })
        .catch(function (e) {
          resultsEl.innerHTML = '';
          toast('Adresssuche fehlgeschlagen: ' + e.message, true);
        });
    }, wait);
  }

  /* ===================================================================== */
  /*  issues panel + toast                                                 */
  /* ===================================================================== */

  function renderIssues() {
    var errs = issues.filter(function (i) { return i.level === 'error'; }).length;
    var warns = issues.length - errs;
    var btn = $('btn-issues');

    if (!issues.length) {
      btn.hidden = true;
      $('issues').hidden = true;
      return;
    }
    btn.hidden = false;
    btn.className = 'ebtn ebtn--issues' + (errs ? '' : ' is-warn');
    btn.textContent = errs
      ? errs + (errs === 1 ? ' Fehler' : ' Fehler') + (warns ? ' · ' + warns + ' Hinweis(e)' : '')
      : warns + (warns === 1 ? ' Hinweis' : ' Hinweise');

    var ul = $('issues-list');
    ul.innerHTML = '';
    issues.forEach(function (p) {
      var li = doc.createElement('li');
      if (p.level === 'warn') li.className = 'is-warn';
      li.textContent = p.msg;
      if (p.id) {
        li.title = 'Zu diesem Ort springen';
        li.addEventListener('click', function () { select(p.id); });
      }
      ul.appendChild(li);
    });
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (bad ? ' is-bad' : '');
    el.hidden = false;
    global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { el.hidden = true; }, bad ? 6000 : 3500);
  }

  /* ===================================================================== */
  /*  wiring                                                               */
  /* ===================================================================== */

  function bindGameField(id, apply) {
    $(id).addEventListener('input', function () {
      apply($(id).type === 'checkbox' ? $(id).checked : $(id).value);
      touch();
    });
  }

  function wire() {
    $('btn-open').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) openFile(e.target.files[0]);
      e.target.value = '';
    });
    $('btn-load-game').addEventListener('click', function () {
      if (dirty && !global.confirm('Ungespeicherte Änderungen verwerfen?')) return;
      loadGameFile();
    });
    $('btn-new').addEventListener('click', function () {
      if (dirty && !global.confirm('Ungespeicherte Änderungen verwerfen?')) return;
      clearDraft();
      adopt(blankDocument(), 'locations.json');
      toast('Leere Datei angelegt.');
    });
    $('btn-download').addEventListener('click', download);
    $('btn-add').addEventListener('click', addLocation);
    $('btn-fit').addEventListener('click', fitAll);
    $('btn-north').addEventListener('click', function () {
      if (map) map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
    });
    $('btn-issues').addEventListener('click', function () {
      $('issues').hidden = !$('issues').hidden;
    });
    $('btn-issues-close').addEventListener('click', function () { $('issues').hidden = true; });

    $('btn-bump').addEventListener('click', function () {
      model.game.version = bumpVersion(model.game.version);
      $('g-version').value = model.game.version;
      touch();
    });
    $('btn-centre-here').addEventListener('click', function () {
      if (!map) return;
      var c = map.getCenter();
      model.game.map.initialCenter = { lat: round6(c.lat), lon: round6(c.lng) };
      model.game.map.initialZoom = Math.round(map.getZoom() * 2) / 2;
      $('g-zoom').value = model.game.map.initialZoom;
      renderCentreText();
      touch();
      toast('Startansicht übernommen.');
    });

    bindGameField('g-title', function (v) { model.game.title = v; });
    bindGameField('g-subtitle', function (v) { model.game.subtitle = v; });
    bindGameField('g-version', function (v) { model.game.version = v; });
    bindGameField('g-radius', function (v) { model.game.defaultRadiusMeters = parseInt(v, 10) || 40; });
    bindGameField('g-shuffle', function (v) { model.game.shuffleAnswers = v; });
    bindGameField('g-tileurl', function (v) { model.game.map.tileUrl = v; });
    bindGameField('g-tileattr', function (v) { model.game.map.tileAttribution = v; });
    bindGameField('g-zoom', function (v) { model.game.map.initialZoom = parseFloat(v) || 15; });

    Array.prototype.forEach.call(doc.querySelectorAll('[data-toggle]'), function (btn) {
      btn.addEventListener('click', function () {
        var body = $(btn.dataset.toggle);
        body.hidden = !body.hidden;
        btn.classList.toggle('is-closed', body.hidden);
      });
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && placingId) {
        placingId = null;
        $('map-hint').hidden = true;
      }
    });

    global.addEventListener('beforeunload', function (e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function bumpVersion(v) {
    var parts = String(v || '0.0.0').split('.');
    while (parts.length < 3) parts.push('0');
    var last = parseInt(parts[parts.length - 1], 10);
    parts[parts.length - 1] = String(isNaN(last) ? 1 : last + 1);
    return parts.join('.');
  }

  /* ===================================================================== */
  /*  boot                                                                 */
  /* ===================================================================== */

  function boot() {
    model = blankDocument();
    wire();
    initMap();

    var draft = readDraft();
    if (draft && draft.doc) {
      var when = new Date(draft.at).toLocaleString('de-AT');
      if (global.confirm('Es liegt ein ungespeicherter Entwurf vom ' + when + ' vor ('
          + draft.name + ').\n\nEntwurf laden?  (Abbrechen lädt stattdessen die Spieldatei.)')) {
        try {
          adopt(draft.doc, draft.name);
          setDirty(true);
          toast('Entwurf wiederhergestellt.');
          return;
        } catch (e) { /* fall through to the game file */ }
      }
      clearDraft();
    }
    loadGameFile();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
