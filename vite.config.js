export default {
  server: {
    proxy: {
      // IMD GeoServer (district warnings) does not send CORS headers, so it is
      // proxied through the Vite dev server. In production, add an equivalent
      // reverse-proxy rule on the host (e.g. nginx "/imdwfs" -> geoserver).
      '/imdwfs': {
        target: 'https://reactjs.imd.gov.in/geoserver',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/imdwfs/, '')
      }
    }
  }
}