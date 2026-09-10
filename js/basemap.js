/* =========================================================================
   basemap.js - the bits of map handling the game and the editor share.

   Both need the same raster basemap built from the `game.map` block of a
   locations file, and both draw the trigger radius of a location as a circle.
   Keeping that here means a change to the tile source or the projection maths
   reaches the game and the editor at once.

   Requires geo.js. Exposes the global `Basemap`.
   ========================================================================= */
(function (global) {
  'use strict';

  var FALLBACK_CENTRE = { lat: 48.18885, lon: 16.40472 };   // Media Quarter Marx
  var FALLBACK_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  var Basemap = {
    /** The MapLibre style document for a plain raster basemap. */
    style: function (cfg) {
      cfg = cfg || {};
      return {
        version: 8,
        sources: {
          basemap: {
            type: 'raster',
            tiles: [cfg.tileUrl || FALLBACK_TILES],
            tileSize: 256,
            maxzoom: cfg.maxZoom || 19,
            attribution: cfg.tileAttribution || '&copy; OpenStreetMap'
          }
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#D4D9E3' } },
          { id: 'basemap', type: 'raster', source: 'basemap' }
        ]
      };
    },

    /**
     * Creates a map with pinch-zoom and two-finger rotation enabled and the
     * pitch gesture disabled (a tilted map is no use to either tool).
     *
     * @param {string|HTMLElement} container
     * @param {object} cfg   the `game.map` block of a locations file
     * @param {object} [opts]  { zoom }
     * @returns {maplibregl.Map|null}  null when the device has no WebGL.
     */
    create: function (container, cfg, opts) {
      cfg = cfg || {};
      opts = opts || {};
      var centre = cfg.initialCenter || FALLBACK_CENTRE;
      var map;

      try {
        map = new global.maplibregl.Map({
          container: container,
          style: this.style(cfg),
          center: [centre.lon, centre.lat],
          zoom: opts.zoom || cfg.initialZoom || 15.5,
          bearing: 0,
          pitch: 0,
          maxZoom: (cfg.maxZoom || 19) + 1,
          pitchWithRotate: false,
          attributionControl: { compact: true }
        });
      } catch (err) {
        return null;
      }

      var enableGestures = function () {
        map.touchZoomRotate.enableRotation();   // two-finger twist
        map.dragRotate.enable();                // desktop: right-drag
        try { map.touchPitch.disable(); } catch (e) { /* older builds */ }
      };
      if (map.isStyleLoaded()) enableGestures();
      else map.once('style.load', enableGestures);

      return map;
    },

    /** A GeoJSON polygon approximating the trigger radius of a location. */
    circleFeature: function (lat, lon, radiusMeters, props) {
      return {
        type: 'Feature',
        properties: props || {},
        geometry: {
          type: 'Polygon',
          coordinates: [global.Geo.circleRing(lat, lon, radiusMeters)]
        }
      };
    },

    featureCollection: function (features) {
      return { type: 'FeatureCollection', features: features || [] };
    },

    /** Replaces the data of a GeoJSON source, if it exists yet. */
    setData: function (map, sourceId, features) {
      var src = map.getSource(sourceId);
      if (src) src.setData(this.featureCollection(features));
    }
  };

  global.Basemap = Basemap;
})(window);
