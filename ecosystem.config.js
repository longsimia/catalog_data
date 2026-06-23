const path = require('path');
const os = require('os');

module.exports = {
  apps: [
    {
      name: 'catalog',
      script: './server.js',
      cwd: __dirname,
      env: {
        PORT: process.env.PORT || 3000,
        DATA_DIR: process.env.DATA_DIR || path.join(os.homedir(), 'catalog_data')
      }
    }
  ]
};
