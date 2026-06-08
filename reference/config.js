'use strict';

require('dotenv').config();

module.exports = {
  spa: {
    host: process.env.SPA_HOST || '192.168.3.128',
    port: parseInt(process.env.SPA_PORT || '8899', 10)
  },
  mqtt: {
    host:     process.env.MQTT_HOST     || '192.168.15.115',
    port:     parseInt(process.env.MQTT_PORT || '1883', 10),
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: `als-sundance-${Date.now()}`
  },
  logLevel: process.env.LOG_LEVEL || 'info'
};
