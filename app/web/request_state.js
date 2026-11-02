/* A request can update its view only while its selection is still current. */
(() => {
    const versions = new Map();
    function begin(...keys) {
        const captured = keys.map(key => { const version = (versions.get(key) || 0) + 1; versions.set(key, version); return [key, version]; });
        return () => captured.every(([key, version]) => versions.get(key) === version);
    }
    window.VisualQARequests = {begin};
})();
