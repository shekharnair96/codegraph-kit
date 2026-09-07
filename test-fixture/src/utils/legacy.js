const { buildSeries } = require("./series");

function legacyBuild(metric) {
  return buildSeries(metric);
}

module.exports = { legacyBuild };
