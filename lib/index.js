'use strict';

const zlib = require('zlib');
const dgram = require('dgram');
const util = require('util');
const OS = require('os');
const debug = require('debug')('log4js:gelf-appender');

/* eslint no-unused-vars:0 */
const LOG_EMERG = 0; // system is unusable(unused)
const LOG_ALERT = 1; // action must be taken immediately(unused)
const LOG_CRIT = 2; // critical conditions
const LOG_ERROR = 3; // error conditions
const LOG_WARNING = 4; // warning conditions
const LOG_NOTICE = 5; // normal, but significant, condition(unused)
const LOG_INFO = 6; // informational message
const LOG_DEBUG = 7; // debug-level message

/**
 * GELF appender that supports sending UDP packets to a GELF compatible server such as Graylog
 *
 * @param layout a function that takes a logevent and returns a string (defaults to none).
 * @param config.host - host to which to send logs (default:localhost)
 * @param config.port - port at which to send logs to (default:12201)
 * @param config.hostname - hostname of the current host (default:OS hostname)
 * @param config.facility - facility to log to (default:nodejs-server)
 */
/* eslint no-underscore-dangle:0 */
function gelfAppender(layout, config, levels) {
  const levelMapping = {};
  levelMapping[levels.ALL] = LOG_DEBUG;
  levelMapping[levels.TRACE] = LOG_DEBUG;
  levelMapping[levels.DEBUG] = LOG_DEBUG;
  levelMapping[levels.INFO] = LOG_INFO;
  levelMapping[levels.WARN] = LOG_WARNING;
  levelMapping[levels.ERROR] = LOG_ERROR;
  levelMapping[levels.FATAL] = LOG_CRIT;

  debug('Appender create with config ', config);
  const appendCategory = config.appendCategory || undefined;
  const host = config.host || 'localhost';
  const port = config.port || 12201;
  const hostname = config.hostname || OS.hostname();
  const facility = config.facility;
  const customFields = config.customFields;

  const defaultCustomFields = customFields || {};

  if (facility) {
    defaultCustomFields._facility = facility;
  }

  const client = dgram.createSocket('udp4');
  const exit = () => client.close();
  process.on('exit', exit);

  /**
   * Add custom fields (start with underscore )
   * - if the first object passed to the logger contains 'GELF' field,
   *   copy the underscore fields to the message
   * @param loggingEvent
   * @param msg
   */
  function addCustomFields(loggingEvent, msg) {
    /* append defaultCustomFields firsts */
    Object.keys(defaultCustomFields).forEach((key) => {
      // skip _id field for graylog2, skip keys not starts with UNDERSCORE
      if (key.match(/^_/) && key !== '_id') {
        msg[key] = defaultCustomFields[key];
      }
    });

    if (appendCategory) {
      msg[`_${appendCategory}`] = loggingEvent.categoryName;
    }

    /* append custom fields per message */
    const data = loggingEvent.data;
    const firstData = data[0];
    if (firstData) {
      if (!firstData.GELF) return; // identify with GELF field defined
      Object.keys(firstData).forEach((key) => {
        // skip _id field for graylog2, skip keys not starts with UNDERSCORE
        if (key.match(/^_/) && key !== '_id') {
          msg[key] = firstData[key];
        }
      });

      /* the custom field object should be removed, so it will not be logged by the later appenders */
      loggingEvent.data.shift();
    }
  }

  function preparePacket(loggingEvent) {
    const msg = {};
    addCustomFields(loggingEvent, msg);
    msg.short_message = loggingEvent.data[0];

    if (loggingEvent.data[1]) {
      msg.full_message = loggingEvent.data[1].stack;
    } else {
      msg.full_message = '';
    }

    msg.version = '1.1';
    msg.timestamp = msg.timestamp || new Date().getTime() / 1000; // log should use millisecond
    msg.host = hostname;
    msg.level = levelMapping[loggingEvent.level];
    return msg;
  }

  function sendPacket(packet) {
    debug('Packet being sent over UDP');
    client.send(packet, 0, packet.length, port, host, (err) => {
      if (err) {
        console.error(err); // eslint-disable-line
      }
    });
  }

  const app = (loggingEvent) => {
    const message = preparePacket(loggingEvent);
    zlib.gzip(Buffer.from(JSON.stringify(message)), (err, packet) => {
      if (err) {
        console.error(err.stack); // eslint-disable-line
      } else {
        if (packet.length > 8192) { // eslint-disable-line
          debug(`Message packet length (${packet.length}) is larger than 8k. Not sending`);
        } else {
          debug(`Message packet length: ${packet.length}`);
          sendPacket(packet);
        }
      }
    });
  };
  app.shutdown = function (cb) {
    debug('Shutdown called');
    client.close(cb);
    process.removeListener('exit', exit);
  };

  return app;
}

function configure(config, layouts, findAppender, levels) {
  let layout = layouts.messagePassThroughLayout;
  if (config.layout) {
    layout = layouts.layout(config.layout.type, config.layout);
  }
  return gelfAppender(layout, config, levels);
}

module.exports.configure = configure;
