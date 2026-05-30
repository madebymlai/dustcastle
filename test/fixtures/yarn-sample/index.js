const isNumber = require("is-number");
module.exports = (x) => (isNumber(x) ? "number" : "other");
