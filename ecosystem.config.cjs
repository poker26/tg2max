module.exports = {
  apps: [
    {
      name: "tg2max-web",
      cwd: "/root/tg2max",
      script: "npm",
      args: "run web",
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        TG2MAX_WEB_PORT: "3020",
      },
    },
  ],
};
