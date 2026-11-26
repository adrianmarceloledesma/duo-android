const { existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ||
    (existsSync(join(__dirname, 'google-services.json')) ? './google-services.json' : undefined);

  return googleServicesFile
    ? { ...config, android: { ...config.android, googleServicesFile } }
    : config;
};
