module.exports = {
  apps: [{
    name: 'als-sundance',
    script: 'server.js',
    exec_mode: 'fork',       // fork mode captures stdout/stderr correctly
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '100M',
    restart_delay: 5000,
    max_restarts: 20,
    env: {
      NODE_ENV: 'production',
      TZ: 'Europe/Vienna'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/als-sundance/error.log',
    out_file: '/var/log/als-sundance/out.log',
    merge_logs: true
  }]
};
