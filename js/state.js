/* =========================================================================
   state.js - the persistent game state.

   Everything the team has achieved lives in localStorage and is rewritten
   synchronously on every change, so closing the tab, locking the phone or
   having the browser evict the page loses nothing. `signature` ties a saved
   game to a specific version of data/locations.json: bump `game.version`
   there and every phone starts fresh.
   ========================================================================= */
(function (global) {
  'use strict';

  var KEY = 'bfi-campus-quest/v1';
  var memoryFallback = null;   // used when localStorage is blocked
  var storageWorks = true;

  function read() {
    if (!storageWorks) return memoryFallback;
    try {
      var raw = global.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      storageWorks = false;
      return memoryFallback;
    }
  }

  function write(state) {
    memoryFallback = state;
    if (!storageWorks) return;
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      storageWorks = false;
    }
  }

  function blank(signature) {
    return {
      v: 1,
      sig: signature,
      team: '',
      startedAt: null,
      finishedAt: null,
      results: {},      // locationId -> { choice, correct, points, at }
      open: null,       // { id, order: [...], at } - question already revealed
      ui: { headingUp: false, dev: false },
      lastScreen: 'start'
    };
  }

  var GameState = {
    state: null,

    /** Loads a saved game, or a blank one if none matches this config. */
    init: function (signature) {
      var saved = read();
      if (saved && saved.v === 1 && saved.sig === signature) {
        this.state = saved;
        // Defensive: older or hand-edited payloads may miss branches.
        if (!this.state.results) this.state.results = {};
        if (!this.state.ui) this.state.ui = { headingUp: false, dev: false };
      } else {
        this.state = blank(signature);
      }
      return this.state;
    },

    /** True when a game is under way or finished and can be resumed. */
    hasProgress: function () {
      return !!(this.state && (this.state.startedAt ||
             Object.keys(this.state.results).length));
    },

    save: function () { write(this.state); return this.state; },

    reset: function () {
      var sig = this.state ? this.state.sig : '';
      var ui = this.state ? this.state.ui : { headingUp: false, dev: false };
      this.state = blank(sig);
      this.state.ui = ui;             // keep north-up / test-mode preference
      return this.save();
    },

    begin: function (teamName) {
      this.state.team = teamName;
      if (!this.state.startedAt) this.state.startedAt = Date.now();
      this.state.finishedAt = null;
      this.state.lastScreen = 'map';
      return this.save();
    },

    /** Marks a question as revealed, so a page reload cannot skip it. */
    openQuestion: function (id, order) {
      this.state.open = { id: id, order: order, at: Date.now() };
      this.state.lastScreen = 'quiz';
      return this.save();
    },

    recordAnswer: function (id, choiceIndex, isCorrect, points) {
      this.state.results[id] = {
        choice: choiceIndex,
        correct: !!isCorrect,
        points: isCorrect ? points : 0,
        at: Date.now()
      };
      this.state.open = null;
      return this.save();
    },

    isAnswered: function (id) {
      return Object.prototype.hasOwnProperty.call(this.state.results, id);
    },

    score: function () {
      var total = 0, r = this.state.results;
      for (var k in r) if (r.hasOwnProperty(k)) total += (r[k].points || 0);
      return total;
    },

    answeredCount: function () { return Object.keys(this.state.results).length; },

    finish: function () {
      if (!this.state.finishedAt) this.state.finishedAt = Date.now();
      this.state.lastScreen = 'end';
      return this.save();
    },

    setScreen: function (name) {
      this.state.lastScreen = name;
      return this.save();
    },

    setUi: function (key, value) {
      this.state.ui[key] = value;
      return this.save();
    },

    /** False when the browser refuses to persist (e.g. hard privacy mode). */
    isPersistent: function () { return storageWorks; }
  };

  // Extra safety net: flush when the page is being hidden or torn down.
  ['pagehide', 'beforeunload'].forEach(function (ev) {
    global.addEventListener(ev, function () {
      if (GameState.state) GameState.save();
    });
  });
  global.document.addEventListener('visibilitychange', function () {
    if (global.document.visibilityState === 'hidden' && GameState.state) GameState.save();
  });

  global.GameState = GameState;
})(window);
