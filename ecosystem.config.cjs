// Konfigurasi pm2 untuk VPS: `npm run build && pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'lp-monitor',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1, // wajib 1: tracker & job Track Wallet menyimpan state di memori
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
