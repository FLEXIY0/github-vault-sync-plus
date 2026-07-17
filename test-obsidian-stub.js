// Test stub for the "obsidian" module: network always fails (offline test)
exports.requestUrl = () => {
  throw new Error("offline");
};
