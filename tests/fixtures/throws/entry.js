// IIFE bundle that throws during __render() to test error handling
(function() {
  globalThis.__render = async function(_request) {
    throw new Error("Intentional render error for testing");
  };
})();
