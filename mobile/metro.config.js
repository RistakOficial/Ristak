const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// Shared contact-filter helpers live alongside mobile/; keep them visible to Metro.
config.watchFolders = [path.resolve(__dirname, '../shared')];
module.exports = config;
