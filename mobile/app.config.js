const fs = require('fs')
const path = require('path')

module.exports = ({ config }) => {
  const finalConfig = {
    ...config,
    android: {
      ...config.android,
    },
  }

  const googleServicesPath = path.join(__dirname, 'google-services.json')
  if (fs.existsSync(googleServicesPath)) {
    finalConfig.android.googleServicesFile = './google-services.json'
  }

  return finalConfig
}
