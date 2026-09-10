/* =========================================================================
   geo.js - geodesic helpers, compass handling and formatting.
   No dependencies. Exposes the global `Geo`.
   ========================================================================= */
(function (global) {
  'use strict';

  var R = 6378137; // earth radius in metres (WGS84)
  var toRad = function (d) { return d * Math.PI / 180; };
  var toDeg = function (r) { return r * 180 / Math.PI; };

  /** Great-circle distance between two WGS84 points, in metres. */
  function distance(lat1, lon1, lat2, lon2) {
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Initial bearing from point 1 to point 2, in degrees clockwise from north. */
  function bearing(lat1, lon1, lat2, lon2) {
    var p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** A closed ring of [lon,lat] pairs approximating a circle - for GeoJSON. */
  function circleRing(lat, lon, radiusMeters, steps) {
    steps = steps || 72;
    var ring = [];
    var d = radiusMeters / R;
    var p = toRad(lat), l = toRad(lon);
    var sinP = Math.sin(p), cosP = Math.cos(p), sinD = Math.sin(d), cosD = Math.cos(d);
    for (var i = 0; i <= steps; i++) {
      var b = 2 * Math.PI * i / steps;
      var p2 = Math.asin(sinP * cosD + cosP * sinD * Math.cos(b));
      var l2 = l + Math.atan2(Math.sin(b) * sinD * cosP, cosD - sinP * Math.sin(p2));
      ring.push([toDeg(l2), toDeg(p2)]);
    }
    return ring;
  }

  /** Shortest signed difference between two angles, in (-180, 180]. */
  function angleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
  }

  /** "245 m" / "1,4 km" - German number formatting. */
  function formatDistance(m) {
    if (!isFinite(m)) return '–';
    if (m < 1000) return Math.round(m) + ' m';
    return (Math.round(m / 100) / 10).toString().replace('.', ',') + ' km';
  }

  /** "3 min 12 s" style duration from milliseconds. */
  function formatDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + ' h ' + m + ' min';
    if (m > 0) return m + ' min ' + (s % 60) + ' s';
    return s + ' s';
  }

  /* ----------------------------------------------------------- compass ---
     Reports the direction the top of the phone points at, in degrees
     clockwise from true(ish) north. Smoothed to stop the arrow twitching.
     ---------------------------------------------------------------------- */
  function Compass(onHeading) {
    this.onHeading = onHeading;
    this.value = null;
    this._handler = this._handle.bind(this);
    this._eventName = null;
  }

  Compass.prototype._screenAngle = function () {
    if (screen && screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    return typeof global.orientation === 'number' ? global.orientation : 0;
  };

  Compass.prototype._handle = function (e) {
    var raw = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      // iOS reports a ready-made compass heading.
      raw = e.webkitCompassHeading;
    } else if (typeof e.alpha === 'number' && e.alpha !== null) {
      raw = (360 - e.alpha + this._screenAngle()) % 360;
    }
    if (raw === null || isNaN(raw)) return;
    raw = (raw + 360) % 360;

    // Circular low-pass filter: move a fraction of the way towards the reading.
    if (this.value === null) this.value = raw;
    else this.value = (this.value + angleDelta(this.value, raw) * 0.25 + 360) % 360;

    this.onHeading(this.value, e.absolute !== false);
  };

  /**
   * Starts listening. On iOS 13+ the permission prompt only appears when this
   * is called from a user gesture, so call it from the start button handler.
   * Resolves with true when a sensor is attached.
   */
  Compass.prototype.start = function () {
    var self = this;
    var attach = function () {
      // `deviceorientationabsolute` gives true north on Android; iOS uses the
      // webkitCompassHeading property on the plain event instead.
      self._eventName = ('ondeviceorientationabsolute' in global)
        ? 'deviceorientationabsolute'
        : 'deviceorientation';
      global.addEventListener(self._eventName, self._handler, true);
      return true;
    };

    var DOE = global.DeviceOrientationEvent;
    if (!DOE) return Promise.resolve(false);

    if (typeof DOE.requestPermission === 'function') {
      return DOE.requestPermission()
        .then(function (res) { return res === 'granted' ? attach() : false; })
        .catch(function () { return false; });
    }
    return Promise.resolve(attach());
  };

  Compass.prototype.stop = function () {
    if (this._eventName) global.removeEventListener(this._eventName, this._handler, true);
    this._eventName = null;
  };

  global.Geo = {
    distance: distance,
    bearing: bearing,
    circleRing: circleRing,
    angleDelta: angleDelta,
    formatDistance: formatDistance,
    formatDuration: formatDuration,
    Compass: Compass
  };
})(window);
