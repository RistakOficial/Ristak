const fs = require('fs')
const path = require('path')

const baseConfig = require('./app.json')

module.exports = () => {
  const config = {
    ...baseConfig.expo,
    android: {
      ...baseConfig.expo.android,
    },
  }

  const googleServicesPath = path.join(__dirname, 'google-services.json')
  if (fs.existsSync(googleServicesPath)) {
    config.android.googleServicesFile = './google-services.json'
  }

  return config
}
