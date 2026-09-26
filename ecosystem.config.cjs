// Konfigurasi pm2 untuk VPS: `npm run build && pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'lp-monitor',
      script: 'dist/index.js',
      cwd: __dirname,
      // Mode fork, 1 instance: tracker & job Track Wallet menyimpan state di memori. Mode cluster juga
      // menyembunyikan error start (mis. port bentrok) sehingga status tetap terlihat "online".
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
