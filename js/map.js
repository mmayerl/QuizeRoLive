/* =========================================================================
   map.js - the map screen, built on MapLibre GL JS.

   The basemap itself is built by basemap.js, which the editor shares; this
   file adds everything specific to playing: numbered target pins, trigger
   zones coloured by result, the player marker and the follow / heading-up
   behaviour. Requires geo.js and basemap.js. Exposes the global `GameMap`.
   ========================================================================= */
(function (global) {
  'use strict';

  // open/me match --slate and --navy in style.css, sampled from the logo.
  var COLOR = { open: '#66769A', done: '#2E7D63', miss: '#B8433C', me: '#17385F' };

  var GameMap = {
    map: null,
    ready: false,
    following: true,      // recentre on the player until they pan away
    headingUp: false,     // rotate the map to the direction they are facing
    _pins: {},            // locationId -> { marker, el }
    _me: null,
    _heading: null,
    _onUserGesture: null,

    /**
     * @param {object} o  { container, config, onMapClick, onUserGesture, onReady }
     * @returns {boolean} false if the device cannot render a WebGL map.
     */
    init: function (o) {
      var cfg = o.config || {};
      this.map = global.Basemap.create(o.container, cfg);
      if (!this.map) return false;   // no WebGL on this device

      var self = this;
      this._onUserGesture = o.onUserGesture || function () {};

      // `style.load` rather than `load`: the latter waits for the first paint,
      // which never comes if the phone is locked or the tab is backgrounded
      // while the game starts - the map would then stay empty.
      var onStyleReady = function () {
        self._addSource('zones', 'fill', {
          'fill-color': ['match', ['get', 'status'], 'done', COLOR.done, 'miss', COLOR.miss, COLOR.open],
          'fill-opacity': 0.14
        });
        self._addSource('zones', 'line', {
          'line-color': ['match', ['get', 'status'], 'done', COLOR.done, 'miss', COLOR.miss, COLOR.open],
          'line-width': 2,
          'line-dasharray': [2, 2]
        }, 'zones-line');
        self._addSource('accuracy', 'fill', {
          'fill-color': COLOR.me, 'fill-opacity': 0.10
        });

        self.ready = true;
        if (o.onReady) o.onReady();
      };

      if (this.map.isStyleLoaded()) onStyleReady();
      else this.map.once('style.load', onStyleReady);

      // Any hands-on gesture releases the automatic follow / heading-up modes.
      this.map.on('dragstart', function () { self.setFollowing(false); });
      this.map.on('rotatestart', function (e) {
        if (e && e.originalEvent) self.setHeadingUp(false);
      });

      if (o.onMapClick) {
        this.map.on('click', function (e) { o.onMapClick(e.lngLat.lat, e.lngLat.lng); });
      }
      return true;
    },

    _addSource: function (name, type, paint, layerId) {
      if (!this.map.getSource(name)) {
        this.map.addSource(name, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      this.map.addLayer({
        id: layerId || (name + '-' + type),
        type: type,
        source: name,
        paint: paint
      });
    },

    _setData: function (name, features) {
      global.Basemap.setData(this.map, name, features);
    },

    /* ------------------------------------------------------------ targets */

    /**
     * @param {Array}  locations  entries from locations.json
     * @param {object} results    GameState results keyed by location id
     * @param {string} defaultRadius
     */
    setTargets: function (locations, results, defaultRadius, onPinClick) {
      if (!this.ready) return;
      var self = this, features = [];

      locations.forEach(function (loc, i) {
        var res = results[loc.id];
        var status = !res ? 'open' : (res.correct ? 'done' : 'miss');
        var radius = loc.radiusMeters || defaultRadius;

        features.push(global.Basemap.circleFeature(loc.lat, loc.lon, radius, { status: status }));

        var entry = self._pins[loc.id];
        if (!entry) {
          var wrap = global.document.createElement('div');
          var pin = global.document.createElement('div');
          pin.className = 'pin';
          pin.innerHTML = '<span></span>';
          wrap.appendChild(pin);
          if (onPinClick) {
            wrap.addEventListener('click', function (ev) {
              ev.stopPropagation();
              onPinClick(loc);
            });
          }
          entry = self._pins[loc.id] = {
            el: pin,
            marker: new global.maplibregl.Marker({ element: wrap, anchor: 'bottom' })
              .setLngLat([loc.lon, loc.lat])
              .addTo(self.map)
          };
        }
        entry.el.className = 'pin' + (status === 'done' ? ' is-done' : status === 'miss' ? ' is-miss' : '');
        entry.el.firstChild.textContent =
          status === 'done' ? '✓' : status === 'miss' ? '✕' : String(i + 1);
      });

      this._setData('zones', features);
    },

    /** Highlights the pin the team is currently standing in. */
    setNear: function (id) {
      for (var key in this._pins) {
        if (!this._pins.hasOwnProperty(key)) continue;
        var el = this._pins[key].el;
        var isOpen = el.className.indexOf('is-done') < 0 && el.className.indexOf('is-miss') < 0;
        el.classList.toggle('is-near', isOpen && key === id);
      }
    },

    /* --------------------------------------------------------------- me --- */

    setUser: function (lat, lon, accuracy) {
      if (!this.ready) return;

      if (!this._me) {
        var el = global.document.createElement('div');
        el.className = 'me';
        // Plain SVG rather than conic-gradient + CSS mask: it renders the same
        // on every phone browser the students might turn up with.
        el.innerHTML =
          '<svg viewBox="0 0 56 56" width="56" height="56">' +
            '<path class="me__cone" d="M28 28 L15 5.4 A26 26 0 0 1 41 5.4 Z"/>' +
            '<circle class="me__ring" cx="28" cy="28" r="11"/>' +
            '<circle class="me__dot" cx="28" cy="28" r="7.5"/>' +
          '</svg>';
        this._me = new global.maplibregl.Marker({
          element: el,
          rotationAlignment: 'map',   // the cone points at real-world north+heading
          pitchAlignment: 'map'
        }).setLngLat([lon, lat]).addTo(this.map);
        if (this._heading !== null) this._me.setRotation(this._heading);
      } else {
        this._me.setLngLat([lon, lat]);
      }

      this._setData('accuracy', accuracy > 0
        ? [global.Basemap.circleFeature(lat, lon, Math.min(accuracy, 250))]
        : []);

      if (this.following) this.map.easeTo({ center: [lon, lat], duration: 600 });
    },

    setHeading: function (deg) {
      this._heading = deg;
      if (this._me) this._me.setRotation(deg);
      // Set the bearing outright rather than animating: compass readings arrive
      // continuously and are already smoothed, so queueing an eased rotation per
      // reading would only make the map fight itself.
      if (this.headingUp && this.ready) this.map.setBearing(deg);
    },

    /* ----------------------------------------------------------- controls */

    setFollowing: function (on) { this.following = !!on; },

    setHeadingUp: function (on) {
      this.headingUp = !!on;
      if (!this.ready) return;
      if (this.headingUp) {
        if (this._heading !== null) this.map.setBearing(this._heading);
      } else {
        this.map.easeTo({ bearing: 0, duration: 400 });
      }
      this._onUserGesture();
    },

    recenter: function (lat, lon) {
      this.setFollowing(true);
      if (!this.ready) return;
      var opts = { duration: 700, zoom: Math.max(this.map.getZoom(), 17) };
      if (typeof lat === 'number') opts.center = [lon, lat];
      this.map.easeTo(opts);
    },

    zoomBy: function (delta) { if (this.ready) this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: 250 }); },

    getBearing: function () { return this.ready ? this.map.getBearing() : 0; },

    fitAll: function (locations, userPos) {
      if (!this.ready || !locations.length) return;
      var b = new global.maplibregl.LngLatBounds();
      locations.forEach(function (l) { b.extend([l.lon, l.lat]); });
      if (userPos) b.extend([userPos.lon, userPos.lat]);
      this.setFollowing(false);
      this.map.fitBounds(b, { padding: 70, maxZoom: 17, duration: 800 });
    },

    resize: function () { if (this.map) this.map.resize(); }
  };

  global.GameMap = GameMap;
})(window);
